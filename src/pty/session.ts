import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import { IDLE_THRESHOLD_MS, type ProcessState } from '../shared/protocol.js';
import { traceInput } from './input-trace.js';
import { OutputRingBuffer, type Snapshot } from './ring-buffer.js';
import { resolveCommand } from './resolve-command.js';

/**
 * PTY内で子プロセスを起動し、出力の配信元となるセッション。
 *
 * - Windowsでは node-pty が ConPTY を使用する。
 * - 出力はリングバッファへ蓄積し、シーケンス番号を割り当てる。
 * - 画面サイズはPC側ターミナルを正とし、リモートからは変更しない。
 */

export interface PtySessionOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly bufferLines: number;
  /** 指定時のみ生PTY出力をファイルへ保存する。 */
  readonly recordPath: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ExitInfo {
  readonly exitCode: number;
  readonly signal: number | null;
}

export class PtySession extends EventEmitter {
  /** 型付きのイベント購読。 */
  override on(event: 'data', listener: (data: string, seq: number) => void): this;
  override on(event: 'exit', listener: (info: ExitInfo) => void): this;
  /**
   * 回復可能な問題の通知。
   * EventEmitter の 'error' は購読者がいないと例外になるため、意図的に別名にしている。
   */
  override on(event: 'warning', listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  private pty: IPty | null = null;
  private readonly buffer: OutputRingBuffer;
  private recordStream: WriteStream | null = null;

  private terminating = false;
  private state: ProcessState = 'starting';
  private lastOutputAt: number | null = null;
  private exitInfo: ExitInfo | null = null;

  readonly displayCommand: string;

  constructor(private readonly options: PtySessionOptions) {
    super();
    this.buffer = new OutputRingBuffer({ maxLines: options.bufferLines });
    this.displayCommand = [options.command, ...options.args].join(' ');
  }

  get processState(): ProcessState {
    if (this.state === 'exited' || this.state === 'starting') return this.state;
    if (
      this.lastOutputAt !== null &&
      Date.now() - this.lastOutputAt >= IDLE_THRESHOLD_MS
    ) {
      return 'idle';
    }
    return 'running';
  }

  get lastOutputTime(): number | null {
    return this.lastOutputAt;
  }

  get exit(): ExitInfo | null {
    return this.exitInfo;
  }

  get currentSeq(): number {
    return this.buffer.currentSeq;
  }

  get isAlive(): boolean {
    return this.pty !== null && this.exitInfo === null;
  }

  snapshotSince(afterSeq: number): Snapshot {
    return this.buffer.snapshotSince(afterSeq);
  }

  /**
   * 子プロセスを起動する。失敗時はエラーメッセージを返す。
   */
  start(): { ok: true } | { ok: false; message: string } {
    const resolved = resolveCommand(this.options.command, this.options.args, this.options.env);
    if (!resolved.ok) {
      return { ok: false, message: resolved.message };
    }

    if (this.options.recordPath !== null) {
      try {
        const target = resolve(this.options.recordPath);
        mkdirSync(dirname(target), { recursive: true });
        this.recordStream = createWriteStream(target, { flags: 'a' });
        // 書き込み中の非同期エラーで落ちないようにする（記録は付随機能）。
        this.recordStream.on('error', (error) => {
          this.emit('warning', error);
          this.recordStream = null;
        });
      } catch (error) {
        return {
          ok: false,
          message: `--record の保存先を開けません: ${(error as Error).message}`,
        };
      }
    }

    try {
      this.pty = spawn(resolved.command.file, [...resolved.command.args], {
        name: 'xterm-256color',
        cols: this.options.cols,
        rows: this.options.rows,
        cwd: this.options.cwd,
        env: { ...(this.options.env ?? process.env) } as { [key: string]: string },
        useConpty: process.platform === 'win32',
      });
    } catch (error) {
      this.closeRecordStream();
      return {
        ok: false,
        message: `子プロセスを起動できません: ${(error as Error).message}`,
      };
    }

    this.state = 'running';

    this.pty.onData((data) => {
      this.lastOutputAt = Date.now();
      const seq = this.buffer.push(data);
      this.recordStream?.write(data);
      this.emit('data', data, seq);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.state = 'exited';
      this.exitInfo = { exitCode, signal: signal ?? null };
      this.closeRecordStream();
      this.emit('exit', this.exitInfo);
    });

    return { ok: true };
  }

  /** PTYへ書き込む。到達順はこの呼び出し順で決まる。 */
  write(data: string): boolean {
    if (this.pty === null || this.exitInfo !== null || this.terminating) return false;
    traceInput('PTY書込', data);
    try {
      this.pty.write(data);
      return true;
    } catch (error) {
      // 終了直後の書き込みなどで例外が出ても、TermWatch自体は落とさない。
      this.emit('warning', error as Error);
      return false;
    }
  }

  /** PC側ターミナルのサイズをPTYへ反映する。リモートからは呼ばない。 */
  resize(cols: number, rows: number): void {
    if (this.pty === null || this.exitInfo !== null) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    try {
      this.pty.resize(safeCols, safeRows);
    } catch (error) {
      // リサイズ失敗は致命的ではない。TUIを壊さないため通知だけ行う。
      this.emit('warning', error as Error);
    }
  }

  /** 子プロセスを終了させる。 */
  kill(): void {
    if (this.pty === null || this.terminating) return;
    this.terminating = true;
    try {
      this.pty.kill();
    } catch {
      // 既に終了している場合は無視する。
    }
  }

  /** メモリ上のバッファと記録ストリームを破棄する。 */
  dispose(): void {
    this.buffer.clear();
    this.closeRecordStream();
    this.removeAllListeners();
  }

  private closeRecordStream(): void {
    if (this.recordStream !== null) {
      this.recordStream.end();
      this.recordStream = null;
    }
  }
}
