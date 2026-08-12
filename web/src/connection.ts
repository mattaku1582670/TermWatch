import type { ClientMessage, ServerMessage } from '../../src/shared/protocol';

/**
 * WebSocket接続の管理。
 *
 * - 指数バックオフ付きの自動再接続。
 * - 再接続時は受信済みの最終シーケンス番号と操作権ハンドルを送り、
 *   欠落なく復帰する。
 */

export type { ConnectionState } from './connection-label';
import type { ConnectionState } from './connection-label';

export interface ConnectionHandlers {
  readonly onMessage: (message: ServerMessage) => void;
  readonly onStateChange: (state: ConnectionState) => void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const PING_INTERVAL_MS = 20_000;

export class Connection {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private stopped = false;
  /** 接続の世代番号。古いソケットのコールバックを無視するために使う。 */
  private generation = 0;

  /** 受信済みの最終シーケンス番号。再接続時に送る。 */
  lastSeq = 0;
  /** 操作権の再接続用ハンドル。 */
  controlHandle: string | null = null;

  constructor(private readonly handlers: ConnectionHandlers) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.handlers.onStateChange('closed');
  }

  send(message: ClientMessage): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private open(): void {
    // 前の接続が残っていれば必ず閉じる（多重接続を防ぐ）。
    if (this.ws !== null) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // 無視。
      }
      this.ws = null;
    }

    const generation = ++this.generation;
    this.handlers.onStateChange(this.backoff === INITIAL_BACKOFF_MS ? 'connecting' : 'reconnecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = (): void => {
      if (generation !== this.generation) {
        socket.close();
        return;
      }
      this.backoff = INITIAL_BACKOFF_MS;
      this.handlers.onStateChange('open');
      this.send({ type: 'resume', lastSeq: this.lastSeq, controlHandle: this.controlHandle });
      this.startPing();
    };

    socket.onmessage = (event: MessageEvent<unknown>): void => {
      if (generation !== this.generation) return;
      if (typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      this.handlers.onMessage(parsed as ServerMessage);
    };

    socket.onclose = (event: CloseEvent): void => {
      if (generation !== this.generation) return;
      this.stopPing();
      this.ws = null;
      if (event.code === 1008) {
        this.handlers.onStateChange('unauthorized');
        return;
      }
      // ハンドシェイクが401で拒否された場合、ブラウザはcloseコード1006しか通知しない。
      // そのため認証状態をHTTPで確認し、失効していれば再接続をやめてペアリングへ戻す。
      void this.checkAuthorization().then((authorized) => {
        if (generation !== this.generation) return;
        if (authorized) {
          this.scheduleReconnect();
        } else {
          this.handlers.onStateChange('unauthorized');
        }
      });
    };

    socket.onerror = (): void => {
      // onclose が続けて呼ばれるため、ここでは何もしない。
    };
  }

  /**
   * セッションが有効かHTTPで確認する。
   * サーバーへ到達できない場合は「有効かもしれない」として再接続を継続する
   * （PC側が一時的に落ちているだけの可能性があるため）。
   */
  private async checkAuthorization(): Promise<boolean> {
    try {
      const response = await fetch('/api/session', { credentials: 'same-origin' });
      if (!response.ok) return true;
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) return true;
      return (body as Record<string, unknown>)['authorized'] !== false;
    } catch {
      return true;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.handlers.onStateChange('reconnecting');
    if (this.reconnectTimer !== null) return;
    const delay = this.backoff + Math.floor(Math.random() * 250);
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** 画面復帰時など、即座に再接続を試みる。 */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = INITIAL_BACKOFF_MS;
    this.open();
  }
}
