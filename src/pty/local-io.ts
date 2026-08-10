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
  private attached = false;
  private rawModeApplied = false;
  private onStdinData: ((chunk: Buffer) => void) | null = null;
  private onResize: (() => void) | null = null;
  private readonly decoder = new StringDecoder('utf8');

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
    if (!this.options.useTitleIndicator) return;
    const suffix = active ? ' [リモート操作モード有効]' : '';
    this.options.stdout.write(`\u001b]2;${this.options.titleBase}${suffix}\u0007`);
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
