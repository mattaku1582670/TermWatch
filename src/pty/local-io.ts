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

export class LocalIo {
  /** この時間だけPTY出力が無ければ、タイトルを書いても安全とみなす。 */
  private static readonly TITLE_QUIET_MS = 60;

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
      if (text.length > 0) this.session.write(text);
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
