import { StringDecoder } from 'node:string_decoder';
import { traceInput } from './input-trace.js';
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

/** win32 input mode のレコード: CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _ */
const WIN32_INPUT_RECORD = new RegExp(`${ESCAPE}\\[([0-9;]*)_`, 'g');
/** 繰り返し回数の上限。壊れた入力で大量生成しないための保険。 */
const MAX_REPEAT = 1024;
/** レコードの項目数の上限。これを超えるものは別物として扱う。 */
const WIN32_FIELD_COUNT = 6;

/**
 * PC側ターミナルが win32 input mode で送ってきた入力を、生のバイト列へ戻す。
 *
 * 子プロセス（Codex など）が `ESC[?9001h` を出すと、その要求は TermWatch を
 * 素通りして VS Code のターミナルへ届く。するとターミナルはキー入力を
 * レコード形式で送ってくるが、矢印キーは仮想キーコードを伴わず
 * `ESC` `[` `A` の3文字ぶんのレコードに分解されてしまう（実測。D-019）。
 *
 * これをそのまま ConPTY へ渡すと3打鍵として扱われ、子プロセスには
 * 「Escキー」＋文字 `[` ＋文字 `A` として届く（画面には `[A` と出る）。
 * 文字コードへ復号して1本のバイト列に戻せば、ConPTY が本来のキーへ変換する。
 *
 * 畳むのは **仮想キーコードもスキャンコードも持たない**（Vk=0 かつ Sc=0）
 * 文字レコードだけに限る。Ctrl+Space やファンクションキーのように
 * Vk / Sc / 修飾キーに意味があるレコードは ConPTY 自身が解釈できるため、
 * 手を触れずそのまま渡す。文字コードへ縮退させると、これらが失われる（D-023）。
 *
 * 項目は末尾から省略できる（`ESC[65;30;97;1_` も正規のレコード）。
 * 省略分は Kd=0 / Cs=0 / Rc=1 の既定値として扱う。
 */
export function decodeWin32InputMode(text: string): string {
  // 終端文字 `_` を含まなければ、このモードのレコードは存在しない。
  if (!text.includes(String.fromCharCode(0x5f))) return text;

  return text.replace(WIN32_INPUT_RECORD, (match: string, params: string): string => {
    const fields = params.split(';');
    // 項目が多すぎるものは win32 input mode のレコードではない。手を触れない。
    if (fields.length > WIN32_FIELD_COUNT) return match;

    const num = (index: number, fallback: number): number => {
      const raw = fields[index];
      if (raw === undefined || raw === '') return fallback;
      const value = Number.parseInt(raw, 10);
      return Number.isFinite(value) ? value : fallback;
    };

    // 仮想キーコード／スキャンコードを持つレコードは ConPTY へそのまま渡す。
    if (num(0, 0) !== 0 || num(1, 0) !== 0) return match;

    if (num(3, 0) === 0) return ''; // 離すイベント
    const unicode = num(2, 0);
    if (unicode <= 0 || unicode > 0x10ffff) return ''; // 文字を伴わないレコード

    const repeat = Math.min(Math.max(num(5, 1), 1), MAX_REPEAT);
    return String.fromCodePoint(unicode).repeat(repeat);
  });
}

/**
 * PTY出力のエスケープシーケンス解析状態。
 *
 * `ground` は「シーケンスの途中ではない」状態で、ここでのみ
 * 別の書き込み（ウィンドウタイトル）を挟んでよい。
 */
export type VtState = 'ground' | 'escape' | 'csi' | 'ss3' | 'osc' | 'oscEscape';

/**
 * 出力チャンクを読み進めた後の解析状態を返す。
 *
 * 子プロセスの出力はチャンク境界で分割されるため、状態をチャンクを跨いで
 * 持ち越す必要がある。経過時間だけで判断すると、`ESC[` を出したまま
 * 子プロセスが待機した場合に未完のシーケンスへ割り込んでしまう（D-024）。
 */
export function nextVtState(chunk: string, state: VtState): VtState {
  let current = state;
  for (let i = 0; i < chunk.length; i += 1) {
    const ch = chunk[i] as string;
    const code = chunk.charCodeAt(i);

    switch (current) {
      case 'ground':
        if (ch === ESCAPE) current = 'escape';
        break;
      case 'escape':
        if (ch === String.fromCharCode(0x5b)) current = 'csi';
        else if (ch === String.fromCharCode(0x5d)) current = 'osc';
        else if (ch === 'O') current = 'ss3';
        else current = 'ground'; // ESC + 1文字で完結
        break;
      case 'csi':
        // 0x40-0x7E が終端文字。
        if (code >= 0x40 && code <= 0x7e) current = 'ground';
        break;
      case 'ss3':
        current = 'ground';
        break;
      case 'osc':
        if (ch === BELL) current = 'ground';
        else if (ch === ESCAPE) current = 'oscEscape';
        break;
      case 'oscEscape':
        // ESC \ (ST) で終端。それ以外は OSC 本文の続きとみなす。
        current = ch === String.fromCharCode(0x5c) ? 'ground' : 'osc';
        break;
    }
  }
  return current;
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
  /** PTY出力の解析状態。ground 以外のときタイトルを書くと表示が壊れる。 */
  private outputState: VtState = 'ground';

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
      traceInput('stdin受信', text);
      if (text.length === 0) return;
      this.pendingInput += text;
      this.flushLocalInput();
    };
    stdin.on('data', this.onStdinData);

    this.session.on('data', (data: string) => {
      // 出力中はタイトルを書き込まない。エスケープシーケンスの途中に
      // 割り込むと、断片が文字として表示されてしまう。
      this.lastOutputAt = Date.now();
      this.outputState = nextVtState(data, this.outputState);
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

    const raw = this.pendingInput;
    this.pendingInput = '';
    if (raw.length === 0) return;

    // win32 input mode のレコードは生のバイト列へ戻してから渡す。
    const data = decodeWin32InputMode(raw);
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

    if (!this.canWriteTitle()) {
      // シーケンスの途中、または出力中。保留して次の機会に書く。
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
    if (!this.canWriteTitle()) return;
    this.lastTitle = null;
    this.writeTitle();
  }

  /**
   * いまタイトルを書き込んでよいか。
   *
   * 条件は2つ。
   * - PTY出力がエスケープシーケンスの途中でないこと（必須）。
   *   途中へ OSC を挟むと端末が誤って解釈し、断片が文字として表示される。
   * - 直前まで出力が続いていないこと（補助）。
   *   解析状態だけでは拾えない、描画のまとまりの途中を避ける。
   */
  private canWriteTitle(): boolean {
    if (this.outputState !== 'ground') return false;
    return Date.now() - this.lastOutputAt >= LocalIo.TITLE_QUIET_MS;
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
      const data = decodeWin32InputMode(this.pendingInput);
      this.pendingInput = '';
      if (data.length > 0) this.session.write(data);
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
