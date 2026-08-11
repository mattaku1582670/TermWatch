import { StringDecoder } from 'node:string_decoder';
import type { PtySession } from './session.js';

/**
 * PC側ターミナル（VS Code統合ターミナル）とPTYの接続。
 *
 * - 標準入力をraw modeにしてPTYへ素通しする（Ctrl+Cも子プロセスへ届く）。
 * - PTY出力を標準出力へそのまま書く。
 * - 端末サイズはPC側を正としてPTYへ反映する。
 * - 正常終了・例外・シグナルのいずれでも raw mode とカーソルを復元する。
 */

const SHOW_CURSOR = '\u001b[?25h';

export interface LocalIoOptions {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  /** リモート操作モードの状態表示にウィンドウタイトルを使うか。 */
  readonly useTitleIndicator: boolean;
  /** タイトルへ表示する基本文言。 */
  readonly titleBase: string;
}

const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);

/**
 * 末尾のエスケープシーケンスが未完かどうかを判定する。
 *
 * 未完のまま PTY へ書き込むと、ConPTY の win32 input mode が
 * それぞれを別のキー入力として解釈してしまう（矢印キーが `[A` になるなど）。
 *
 * 判定は末尾の ESC 以降だけを見る。それより前は既に完結しているため。
 */
export function isIncompleteEscapeSequence(text: string): boolean {
  const start = text.lastIndexOf(ESCAPE);
  if (start < 0) return false;

  const rest = text.slice(start);
  // ESC だけ。続きが来るかもしれない（単独の Esc キーの可能性もある）。
  if (rest.length === 1) return true;

  const kind = rest[1];

  // CSI: ESC [ <パラメーター> <終端文字(0x40-0x7E)>
  if (kind === String.fromCharCode(0x5b)) {
    for (let i = 2; i < rest.length; i += 1) {
      const code = rest.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return false;
    }
    return true;
  }

  // SS3: ESC O <1文字>（ファンクションキーなど）
  if (kind === 'O') return rest.length < 3;

  // OSC: ESC ] ... BEL もしくは ESC \\
  if (kind === String.fromCharCode(0x5d)) {
    if (rest.includes(BELL)) return false;
    return !rest.slice(2).includes(ESCAPE + String.fromCharCode(0x5c));
  }

  // ESC + 1文字（Alt+キーなど）は完結している。
  return false;
}

export class LocalIo {
  /** この時間だけPTY出力が無ければ、タイトルを書いても安全とみなす。 */
  private static readonly TITLE_QUIET_MS = 60;
  /** 途中で切れたエスケープシーケンスの続きを待つ時間。 */
  private static readonly ESCAPE_JOIN_MS = 20;

  private attached = false;
  private rawModeApplied = false;
  private onStdinData: ((chunk: Buffer) => void) | null = null;
  private onResize: (() => void) | null = null;
  private readonly decoder = new StringDecoder('utf8');
  private remoteControlActive = false;
  private pairingCode: string | null = null;
  private lastTitle: string | null = null;
  /** 最後にPTY出力を書いた時刻。タイトル書き込みの割り込みを避けるために使う。 */
  private lastOutputAt = 0;
  /** 出力中で書けなかったタイトル更新が保留されているか。 */
  private titlePending = false;
  /** まだPTYへ書いていないPC側入力。 */
  private pendingInput = '';
  /** エスケープシーケンスの続きを待つタイマー。 */
  private escapeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly session: PtySession,
    private readonly options: LocalIoOptions,
  ) {}

  /** 現在のPC側ターミナルサイズ。取得できない場合は既定値を返す。 */
  static currentSize(stdout: NodeJS.WriteStream): { cols: number; rows: number } {
    const cols = typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : 120;
    const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : 30;
    return { cols, rows };
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    const { stdin, stdout } = this.options;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
      this.rawModeApplied = true;
    }
    stdin.resume();

    this.onStdinData = (chunk: Buffer): void => {
      // PC側入力は常に有効。リモートの操作権とは無関係。
      // 日本語などのマルチバイト文字がチャンク境界で分割されても壊れないよう、
      // StringDecoder で持ち越して結合する。
      const text = this.decoder.write(chunk);
      if (text.length === 0) return;
      this.pendingInput += text;
      this.flushLocalInput();
    };
    stdin.on('data', this.onStdinData);

    this.session.on('data', (data: string) => {
      // 出力中はタイトルを書き込まない。エスケープシーケンスの途中に
      // 割り込むと、断片が文字として表示されてしまう。
      this.lastOutputAt = Date.now();
      stdout.write(data);
    });

    this.onResize = (): void => {
      const size = LocalIo.currentSize(stdout);
      this.session.resize(size.cols, size.rows);
    };
    stdout.on('resize', this.onResize);
  }

  /**
   * PC側の入力をPTYへ渡す。
   *
   * エスケープシーケンス（矢印キーの `ESC[A` など）は、端末から
   * 分割して届くことがある。Windows の ConPTY は win32 input mode で
   * 書き込み単位をキー入力へ変換するため、`ESC` と `[A` が別々の書き込みに
   * なると「Escキー」＋「文字 [ A」と解釈され、矢印キーが機能しなくなる。
   *
   * そのため、途中で切れているエスケープシーケンスは少しだけ保持して、
   * 続きが届いてからまとめて書き込む。通常の文字は保持せず即座に送るので、
   * ローカル入力の体感遅延には影響しない。
   */
  private flushLocalInput(force = false): void {
    if (this.escapeTimer !== null) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }

    if (!force && isIncompleteEscapeSequence(this.pendingInput)) {
      // 続きを少しだけ待つ。単独のEscキー押下もこの時間で送られる。
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null;
        this.flushLocalInput(true);
      }, LocalIo.ESCAPE_JOIN_MS);
      this.escapeTimer.unref?.();
      return;
    }

    const data = this.pendingInput;
    this.pendingInput = '';
    if (data.length > 0) this.session.write(data);
  }

  /**
   * リモートが操作モード中であることをPC側へ知らせる。
   *
   * 子プロセスのTUIを壊さないため、画面本体へは一切書き込まず、
   * ウィンドウタイトル（OSC 2）だけを更新する。
   */
  setRemoteControlIndicator(active: boolean): void {
    this.remoteControlActive = active;
    this.writeTitle();
  }

  /**
   * 有効なペアリングコードをタイトルへ表示する（失効したら null を渡す）。
   *
   * 起動時のバナー表示だけでは、子プロセスが画面消去（ESC[2J）を行った時点で
   * コードが読めなくなる。タイトルは画面バッファとは独立しているため消えない。
   */
  setPairingCode(code: string | null): void {
    this.pairingCode = code;
    this.writeTitle();
  }

  /**
   * タイトルを書き込む。
   *
   * PTY出力の直後は書き込まない。子プロセスのエスケープシーケンスは
   * チャンク境界で分割されて届くことがあり、その途中へ別の書き込みを挟むと
   * 端末が誤って解釈し、断片（例: `[?2004h`）が文字として画面に出てしまう。
   * 出力が落ち着くまで保留し、あとで書き直す。
   */
  writeTitle(): void {
    if (!this.options.useTitleIndicator) return;

    let title = this.options.titleBase;
    if (this.pairingCode !== null) title += ` [ペアリングコード ${this.pairingCode}]`;
    if (this.remoteControlActive) title += ' [リモート操作モード有効]';

    if (title === this.lastTitle) return;

    if (Date.now() - this.lastOutputAt < LocalIo.TITLE_QUIET_MS) {
      // 出力中。保留して次の機会に書く。
      this.titlePending = true;
      return;
    }

    this.titlePending = false;
    this.lastTitle = title;
    this.options.stdout.write(`\u001b]2;${title}\u0007`);
  }

  /**
   * 子プロセスが自分でタイトルを設定して上書きすることがあるため、
   * 定期的に書き直す。ただし表示すべき内容があるときだけ行い、
   * 出力中は書き込まない（上記の理由）。
   */
  refreshTitle(): void {
    if (!this.options.useTitleIndicator) return;
    const hasIndicator = this.pairingCode !== null || this.remoteControlActive;
    // 表示するものが無く、保留中の変更も無ければ何も書かない。
    if (!hasIndicator && !this.titlePending) return;
    if (Date.now() - this.lastOutputAt < LocalIo.TITLE_QUIET_MS) return;
    this.lastTitle = null;
    this.writeTitle();
  }

  /** raw modeとカーソル状態を復元する。多重呼び出し安全。 */
  restore(): void {
    if (!this.attached) return;
    this.attached = false;

    // 保持したままの入力を取りこぼさないよう、最後に書き出す。
    if (this.escapeTimer !== null) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }
    if (this.pendingInput.length > 0) {
      const data = this.pendingInput;
      this.pendingInput = '';
      this.session.write(data);
    }

    const { stdin, stdout } = this.options;

    if (this.onStdinData !== null) {
      stdin.off('data', this.onStdinData);
      this.onStdinData = null;
    }
    if (this.onResize !== null) {
      stdout.off('resize', this.onResize);
      this.onResize = null;
    }

    if (this.rawModeApplied && stdin.isTTY) {
      try {
        stdin.setRawMode(false);
      } catch {
        // 端末が既に閉じている場合は無視する。
      }
      this.rawModeApplied = false;
    }
    try {
      stdin.pause();
    } catch {
      // 無視。
    }

    try {
      stdout.write(SHOW_CURSOR);
      if (this.options.useTitleIndicator) {
        stdout.write(`\u001b]2;${this.options.titleBase}\u0007`);
      }
    } catch {
      // 無視。
    }
  }
}
