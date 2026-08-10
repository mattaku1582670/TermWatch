import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MAX_WS_MESSAGE_BYTES,
  SPECIAL_KEY_SEQUENCES,
  type ControlReason,
  type ControlStatus,
  type ErrorCode,
  type ServerMessage,
  type SessionInfo,
  type StatusPayload,
} from '../shared/protocol.js';
import { checkSameOrigin } from '../security/origin.js';
import { FailureRateLimiter } from '../security/rate-limit.js';
import type { SessionAuth } from '../security/tokens.js';
import type { PtySession } from '../pty/session.js';
import { ControlManager } from './control.js';
import { readAsset } from './http-assets.js';
import { parseClientMessage } from './schema.js';

/**
 * TermWatchのHTTP／WebSocketサーバー。
 *
 * - 127.0.0.1 のみで待ち受ける（0.0.0.0・LAN IPへはbindしない）。
 * - 認証（ワンタイムペアリング → HttpOnly Cookieのセッショントークン）を通過するまで
 *   出力・スナップショット・状態を一切送信しない。
 * - Origin検証によりクロスサイトからのWebSocket接続を拒否する。
 */

const COOKIE_NAME = 'termwatch_session';
/** これを超えたクライアントは遅延中とみなし、送信を止める（バックプレッシャー）。 */
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;
/** ここまで下がったら再開する。 */
const BACKPRESSURE_LOW_WATER = 512 * 1024;
const STATUS_INTERVAL_MS = 1000;
const BACKPRESSURE_CHECK_MS = 200;
/** クライアントごとの受信メッセージ流量上限（10秒あたり）。 */
const MESSAGE_RATE_WINDOW_MS = 10_000;
const MESSAGE_RATE_LIMIT = 300;
/** 同時に受け付けるWebSocketクライアント数の上限。 */
const MAX_CLIENTS = 8;
/** 生存確認の間隔。応答がない接続は切断し、操作権の解除判定へ回す。 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 終了時、接続のクローズを待つ最大時間。 */
const CLOSE_TIMEOUT_MS = 1000;

export interface ServerOptions {
  readonly port: number;
  readonly webRoot: string;
  readonly auth: SessionAuth;
  readonly session: PtySession;
  readonly controlMinutes: number;
  readonly version: string;
  readonly bufferLines: number;
}

interface ClientState {
  readonly ws: WebSocket;
  lastSentSeq: number;
  /** resume を受け取り、配信を開始してよい状態か。 */
  ready: boolean;
  /** ping/pong による生存確認。 */
  alive: boolean;
  lagging: boolean;
  controlHandle: string | null;
  messageCount: number;
  windowStart: number;
}

export type ServerStartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export class TermWatchServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientState>();
  private readonly control: ControlManager;
  private readonly pairingLimiter = new FailureRateLimiter();

  private statusTimer: NodeJS.Timeout | null = null;
  private backpressureTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closePromise: Promise<void> | null = null;

  /** リモート操作モードの有無が変化したときに呼ばれる。 */
  onControlActiveChange: ((active: boolean) => void) | null = null;

  constructor(private readonly options: ServerOptions) {
    this.control = new ControlManager(options.controlMinutes * 60_000);
    this.http = createServer((req, res) => {
      // ハンドラー内の例外でプロセス全体が落ちないよう境界を設ける。
      try {
        this.handleHttp(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    // 接続を握ったまま放置される攻撃（slowloris）への基本的な対策。
    this.http.headersTimeout = 10_000;
    this.http.requestTimeout = 30_000;
    this.http.keepAliveTimeout = 5_000;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });

    this.http.on('upgrade', (req, socket, head) => {
      try {
        this.handleUpgrade(req, socket, head);
      } catch {
        socket.destroy();
      }
    });

    this.options.session.on('data', (data: string, seq: number) => {
      this.broadcastOutput(data, seq);
    });
    this.options.session.on('exit', () => {
      const event = this.control.markProcessExited();
      if (event !== null && event.kind === 'revoked') {
        this.notifyControlChange(event.handle, 'process-exited');
      }
      this.broadcastStatus();
    });
  }

  /** 127.0.0.1 でのみ待ち受ける。 */
  listen(): Promise<ServerStartResult> {
    return new Promise((resolvePromise) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        this.http.off('listening', onListening);
        if (error.code === 'EADDRINUSE') {
          resolvePromise({
            ok: false,
            message:
              `ポート ${this.options.port} は既に使用されています。\n` +
              `別のポートを使う場合は --port を指定してください（自動変更は行いません）。`,
          });
          return;
        }
        resolvePromise({ ok: false, message: `サーバーを起動できません: ${error.message}` });
      };
      const onListening = (): void => {
        this.http.off('error', onError);
        this.startTimers();
        resolvePromise({ ok: true });
      };
      this.http.once('error', onError);
      this.http.once('listening', onListening);
      this.http.listen(this.options.port, '127.0.0.1');
    });
  }

  private startTimers(): void {
    this.statusTimer = setInterval(() => {
      this.tickControl();
      this.broadcastStatus();
    }, STATUS_INTERVAL_MS);
    this.statusTimer.unref();

    this.backpressureTimer = setInterval(() => {
      this.resumeLaggingClients();
    }, BACKPRESSURE_CHECK_MS);
    this.backpressureTimer.unref();

    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeats();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  /**
   * 応答のない接続（半開き状態）を切断する。
   * これにより切断が検出され、操作権の60秒解除タイマーが動き始める。
   */
  private checkHeartbeats(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        client.ws.terminate();
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* HTTP                                                              */
  /* ---------------------------------------------------------------- */

  private securityHeaders(res: ServerResponse, isHtml: boolean): void {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (isHtml) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/api/pair' && req.method === 'POST') {
      this.handlePairRequest(req, res);
      return;
    }

    if (path === '/api/session' && req.method === 'GET') {
      this.securityHeaders(res, false);
      const authorized = this.isAuthorized(req);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ authorized }));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.securityHeaders(res, false);
      res.writeHead(405, { Allow: 'GET, HEAD, POST' });
      res.end();
      return;
    }

    // Web UI本体は認証前でも配信する（ペアリング画面を出すため）。
    // ターミナル出力・状態はWebSocket認証後にしか流れない。
    const asset = readAsset(this.options.webRoot, path) ?? readAsset(this.options.webRoot, '/');
    if (asset === null) {
      this.securityHeaders(res, true);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('見つかりません');
      return;
    }

    this.securityHeaders(res, asset.contentType.startsWith('text/html'));
    res.writeHead(200, { 'Content-Type': asset.contentType });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(asset.body);
  }

  private handlePairRequest(req: IncomingMessage, res: ServerResponse): void {
    this.securityHeaders(res, false);

    const originCheck = checkSameOrigin(
      req.headers.host,
      typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      typeof req.headers['x-forwarded-host'] === 'string'
        ? req.headers['x-forwarded-host']
        : undefined,
    );
    if (!originCheck.ok) {
      this.sendJson(res, 403, { error: 'forbidden' });
      return;
    }

    const now = Date.now();
    if (this.pairingLimiter.isLocked(now)) {
      const retryAfter = Math.ceil(this.pairingLimiter.retryAfterMs(now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      this.sendJson(res, 429, { error: 'rate-limited', retryAfterSeconds: retryAfter });
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > 4096) {
        aborted = true;
        this.sendJson(res, 413, { error: 'too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      let code: unknown;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        code =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)['code']
            : undefined;
      } catch {
        this.sendJson(res, 400, { error: 'invalid-request' });
        return;
      }

      if (typeof code !== 'string' || code.length > 64) {
        this.sendJson(res, 400, { error: 'invalid-request' });
        return;
      }

      const token = this.options.auth.verifyPairing(code, Date.now());
      if (token === null) {
        // 失敗理由（期限切れ／不一致）は区別せず返す。
        this.pairingLimiter.recordFailure(Date.now());
        this.sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      this.pairingLimiter.recordSuccess();
      const secure = this.isSecureRequest(req);
      const cookie =
        `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` +
        (secure ? '; Secure' : '');
      res.setHeader('Set-Cookie', cookie);
      this.sendJson(res, 200, { ok: true });
    });
  }

  private isSecureRequest(req: IncomingMessage): boolean {
    const proto = req.headers['x-forwarded-proto'];
    const value = Array.isArray(proto) ? proto[0] : proto;
    return typeof value === 'string' && value.split(',')[0]?.trim() === 'https';
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  /* ---------------------------------------------------------------- */
  /* 認証                                                              */
  /* ---------------------------------------------------------------- */

  private readCookieToken(req: IncomingMessage): string | null {
    const header = req.headers.cookie;
    if (typeof header !== 'string') return null;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      if (part.slice(0, idx).trim() !== COOKIE_NAME) continue;
      return part.slice(idx + 1).trim();
    }
    return null;
  }

  private isAuthorized(req: IncomingMessage): boolean {
    return this.options.auth.verifyToken(this.readCookieToken(req));
  }

  /* ---------------------------------------------------------------- */
  /* WebSocket                                                         */
  /* ---------------------------------------------------------------- */

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const originCheck = checkSameOrigin(
      req.headers.host,
      typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      typeof req.headers['x-forwarded-host'] === 'string'
        ? req.headers['x-forwarded-host']
        : undefined,
    );
    if (!originCheck.ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!this.isAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (this.clients.size >= MAX_CLIENTS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.registerClient(ws);
    });
  }

  private registerClient(ws: WebSocket): void {
    const client: ClientState = {
      ws,
      lastSentSeq: this.options.session.currentSeq,
      ready: false,
      alive: true,
      lagging: false,
      controlHandle: null,
      messageCount: 0,
      windowStart: Date.now(),
    };
    this.clients.add(client);

    const info: SessionInfo = {
      command: this.options.session.displayCommand,
      version: this.options.version,
      controlDurationMs: this.options.controlMinutes * 60_000,
      bufferLines: this.options.bufferLines,
    };
    this.send(client, { type: 'hello', session: info, mode: 'view' });

    ws.on('message', (data, isBinary) => {
      try {
        this.handleClientMessage(client, data, isBinary);
      } catch {
        this.sendError(client, 'internal', 'メッセージを処理できませんでした。');
      }
    });

    ws.on('pong', () => {
      client.alive = true;
    });

    ws.on('close', () => {
      this.clients.delete(client);
      this.control.detach(client.controlHandle);
      this.updateControlIndicator();
    });

    ws.on('error', () => {
      this.clients.delete(client);
    });
  }

  private handleClientMessage(
    client: ClientState,
    data: unknown,
    isBinary: boolean,
  ): void {
    if (isBinary) {
      this.sendError(client, 'invalid-message', 'バイナリフレームは受け付けません。');
      return;
    }

    const now = Date.now();
    if (now - client.windowStart > MESSAGE_RATE_WINDOW_MS) {
      client.windowStart = now;
      client.messageCount = 0;
    }
    client.messageCount += 1;
    if (client.messageCount > MESSAGE_RATE_LIMIT) {
      this.sendError(client, 'rate-limited', '送信が多すぎます。');
      return;
    }

    const raw = String(data);
    if (Buffer.byteLength(raw, 'utf8') > MAX_WS_MESSAGE_BYTES) {
      this.sendError(client, 'too-large', 'メッセージが大きすぎます。');
      return;
    }

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.sendError(client, parsed.code, parsed.reason);
      return;
    }

    const message = parsed.message;
    switch (message.type) {
      case 'ping':
        return;

      case 'resume': {
        // スナップショットは最大でリングバッファ全体になる。
        // 繰り返し要求による CPU / メモリ消費を防ぐため、1接続につき1回だけ許可する。
        if (client.ready) {
          client.ws.close(1008, 'resume は1接続につき1回だけです');
          return;
        }
        const grant = this.control.attach(message.controlHandle);
        client.controlHandle = grant === null ? null : grant.handle;
        this.updateControlIndicator();
        this.sendSnapshot(client, message.lastSeq);
        this.sendControl(client, 'sync');
        this.sendStatus(client);
        return;
      }

      case 'control.request': {
        const result = this.control.request();
        if (!result.ok) {
          this.sendControl(client, result.reason === 'busy' ? 'denied-busy' : 'process-exited');
          return;
        }
        client.controlHandle = result.grant.handle;
        this.updateControlIndicator();
        this.sendControl(client, 'granted');
        this.broadcastControlToOthers(client);
        return;
      }

      case 'control.release': {
        const event = this.control.release(client.controlHandle);
        client.controlHandle = null;
        this.updateControlIndicator();
        if (event !== null) {
          this.sendControl(client, 'released');
          this.broadcastControlToOthers(client);
        } else {
          this.sendControl(client, 'sync');
        }
        return;
      }

      case 'input.key': {
        if (!this.assertControl(client)) return;
        const sequence = SPECIAL_KEY_SEQUENCES[message.key];
        this.writeToPty(client, sequence);
        return;
      }

      case 'input.text': {
        if (!this.assertControl(client)) return;
        this.writeToPty(client, encodeTextInput(message.text, message.submit));
        return;
      }

      default: {
        this.sendError(client, 'invalid-message', '未知のメッセージです。');
      }
    }
  }

  /**
   * 操作権の検査。閲覧モードのクライアントはここで必ず弾かれる。
   * UIを改変して直接メッセージを送っても、この検査を回避できない。
   */
  private assertControl(client: ClientState): boolean {
    if (!this.control.isHolder(client.controlHandle)) {
      client.controlHandle = null;
      this.sendError(client, 'forbidden', '操作権がありません。閲覧モードでは入力できません。');
      this.sendControl(client, 'sync');
      return false;
    }
    return true;
  }

  private writeToPty(client: ClientState, data: string): void {
    if (data.length === 0) return;
    if (!this.options.session.write(data)) {
      this.sendError(client, 'process-exited', '子プロセスは既に終了しています。');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 配信                                                              */
  /* ---------------------------------------------------------------- */

  private send(client: ClientState, message: ServerMessage): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    client.ws.send(JSON.stringify(message));
  }

  private sendError(client: ClientState, code: ErrorCode, message: string): void {
    this.send(client, { type: 'error', code, message });
  }

  private sendSnapshot(client: ClientState, lastSeq: number): void {
    const snapshot = this.options.session.snapshotSince(lastSeq);
    client.lastSentSeq = snapshot.seq;
    client.lagging = false;
    client.ready = true;
    this.send(client, {
      type: 'snapshot',
      data: snapshot.data,
      seq: snapshot.seq,
      truncated: snapshot.truncated,
    });
  }

  private broadcastOutput(data: string, seq: number): void {
    for (const client of this.clients) {
      if (client.ws.readyState !== client.ws.OPEN) continue;
      if (!client.ready) continue;
      if (client.lagging) continue;
      if (client.ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
        client.lagging = true;
        continue;
      }

      if (client.lastSentSeq === seq - 1) {
        // 通常経路。今回のチャンクだけを送る（バッファ全体を走査しない）。
        client.lastSentSeq = seq;
        this.send(client, { type: 'output', data, seq });
        continue;
      }

      // 送信済み位置とずれている場合だけ、抜けをスナップショットで埋める。
      const snapshot = this.options.session.snapshotSince(client.lastSentSeq);
      if (snapshot.data.length === 0) continue;
      client.lastSentSeq = snapshot.seq;
      this.send(client, { type: 'output', data: snapshot.data, seq: snapshot.seq });
    }
  }

  private resumeLaggingClients(): void {
    for (const client of this.clients) {
      if (!client.lagging) continue;
      if (client.ws.readyState !== client.ws.OPEN) continue;
      if (client.ws.bufferedAmount > BACKPRESSURE_LOW_WATER) continue;
      this.sendSnapshot(client, client.lastSentSeq);
    }
  }

  private buildStatus(client: ClientState): StatusPayload {
    const session = this.options.session;
    const exit = session.exit;
    return {
      process: session.processState,
      exitCode: exit?.exitCode ?? null,
      exitSignal: exit?.signal ?? null,
      lastOutputAt: session.lastOutputTime,
      control: this.buildControlStatus(client),
      viewers: this.clients.size,
    };
  }

  private buildControlStatus(client: ClientState): ControlStatus {
    const mine = this.control.isHolder(client.controlHandle);
    return {
      held: this.control.isHeld(),
      mine,
      expiresAt: mine ? this.control.expiresAt : null,
      handle: mine ? client.controlHandle : null,
    };
  }

  private sendStatus(client: ClientState): void {
    this.send(client, { type: 'status', status: this.buildStatus(client) });
  }

  private broadcastStatus(): void {
    for (const client of this.clients) {
      this.sendStatus(client);
    }
  }

  private sendControl(client: ClientState, reason: ControlReason): void {
    this.send(client, { type: 'control', control: this.buildControlStatus(client), reason });
  }

  private broadcastControlToOthers(origin: ClientState): void {
    for (const client of this.clients) {
      if (client === origin) continue;
      this.sendControl(client, 'sync');
    }
  }

  private notifyControlChange(handle: string, reason: ControlReason): void {
    for (const client of this.clients) {
      if (client.controlHandle === handle) {
        client.controlHandle = null;
        this.sendControl(client, reason);
      }
    }
    this.updateControlIndicator();
  }

  private tickControl(): void {
    for (const event of this.control.tick()) {
      if (event.kind === 'revoked') {
        this.notifyControlChange(event.handle, event.reason);
      } else {
        for (const client of this.clients) {
          if (client.controlHandle === event.handle) {
            this.sendControl(client, 'sync');
          }
        }
      }
    }
  }

  private updateControlIndicator(): void {
    this.onControlActiveChange?.(this.control.isHeld());
  }

  /* ---------------------------------------------------------------- */
  /* 終了処理                                                          */
  /* ---------------------------------------------------------------- */

  /** 接続中のクライアントへ最終状態を送る。 */
  flushFinalStatus(): void {
    this.broadcastStatus();
  }

  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  /**
   * サーバーを閉じる。
   *
   * keep-alive接続や応答しないクライアントが残っていても終了できるよう、
   * 一定時間で強制切断へ切り替える（TermWatchの終了が待たされないようにする）。
   */
  private async doClose(): Promise<void> {
    for (const timer of [this.statusTimer, this.backpressureTimer, this.heartbeatTimer]) {
      if (timer !== null) clearInterval(timer);
    }
    this.statusTimer = null;
    this.backpressureTimer = null;
    this.heartbeatTimer = null;

    this.control.dispose();

    const clients = [...this.clients];
    for (const client of clients) {
      try {
        client.ws.close(1001, 'TermWatch終了');
      } catch {
        // 無視。
      }
    }

    const graceful = Promise.all([
      new Promise<void>((resolvePromise) => this.wss.close(() => resolvePromise())),
      new Promise<void>((resolvePromise) => this.http.close(() => resolvePromise())),
    ]);
    const timeout = new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, CLOSE_TIMEOUT_MS);
    });
    await Promise.race([graceful, timeout]);

    // 期限までに閉じなかった接続を強制的に破棄する。
    for (const client of clients) {
      try {
        client.ws.terminate();
      } catch {
        // 無視。
      }
    }
    this.clients.clear();
    this.http.closeAllConnections();
  }
}

/**
 * リモートからのテキスト入力をPTYバイト列へ変換する。
 *
 * 複数行のテキストは bracketed paste で囲み、途中の改行で誤送信されるのを防ぐ。
 * 送信フラグが立っていれば最後にEnter（CR）を送る。
 */
const ESC = String.fromCharCode(0x1b);
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;

export function encodeTextInput(text: string, submit: boolean): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const multiline = normalized.includes('\n');
  const body = normalized.replace(/\n/g, '\r');

  let out = '';
  if (body.length > 0) {
    out += multiline ? `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}` : body;
  }
  if (submit) {
    out += '\r';
  }
  return out;
}
