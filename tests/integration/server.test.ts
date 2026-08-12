import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PtySession } from '../../src/pty/session.js';
import { SessionAuth } from '../../src/security/tokens.js';
import { TermWatchServer } from '../../src/server/server.js';
import type { ServerMessage } from '../../src/shared/protocol.js';

const CHILD = fileURLToPath(new URL('../fixtures/echo-child.mjs', import.meta.url));

let webRoot: string;
let port: number;
let session: PtySession;
let auth: SessionAuth;
let server: TermWatchServer;

/** 空いているTCPポートを取得する。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('ポートを取得できません'));
        return;
      }
      const value = address.port;
      probe.close(() => resolve(value));
    });
  });
}

function origin(): string {
  return `http://127.0.0.1:${port}`;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin(), ...headers },
    body: JSON.stringify(body),
  });
}

/** ペアリングを行い、Cookieヘッダー値を返す。 */
async function pair(): Promise<string> {
  const code = auth.getPairingCodeForDisplay();
  if (code === null) throw new Error('ペアリングコードがありません');
  const response = await post('/api/pair', { code });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('Set-Cookieがありません');
  return setCookie.split(';')[0] as string;
}

interface TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[];
  waitFor<T extends ServerMessage['type']>(type: T, timeoutMs?: number): Promise<ServerMessage>;
  /** 条件を満たすメッセージが届くまで待つ。 */
  waitUntil(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs?: number,
  ): Promise<ServerMessage>;
  close(): void;
}

function connect(cookie: string | null, extraHeaders: Record<string, string> = {}): Promise<TestClient> {
  const headers: Record<string, string> = { Origin: origin(), ...extraHeaders };
  if (cookie !== null) headers['Cookie'] = cookie;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const messages: ServerMessage[] = [];
  const waiters: {
    predicate: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }[] = [];

  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter !== undefined && waiter.predicate(message)) {
        waiters.splice(i, 1);
        waiter.resolve(message);
      }
    }
  });

  const client: TestClient = {
    ws,
    messages,
    // 過去のメッセージは対象にせず、この呼び出し以降に届くものだけを待つ。
    waitFor(type, timeoutMs = 8000) {
      return client.waitUntil((m) => m.type === type, timeoutMs);
    },
    waitUntil(predicate, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('期待するメッセージが届きません')), timeoutMs);
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    close() {
      ws.close();
    },
  };

  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
    });
  });
}

function waitForText(session_: PtySession, needle: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let acc = '';
    const timer = setTimeout(() => reject(new Error(`「${needle}」が出力されません: ${acc}`)), timeoutMs);
    const onData = (data: string): void => {
      acc += data;
      if (acc.includes(needle)) {
        clearTimeout(timer);
        session_.off('data', onData);
        resolve();
      }
    };
    session_.on('data', onData);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  webRoot = mkdtempSync(join(tmpdir(), 'termwatch-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>t</title>');

  port = await freePort();
  session = new PtySession({
    command: process.execPath,
    args: [CHILD],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    bufferLines: 1000,
    recordPath: null,
  });
  auth = new SessionAuth();
  server = new TermWatchServer({
    port,
    webRoot,
    auth,
    session,
    controlMinutes: 10,
    bufferLines: 1000,
    version: 'test',
  });
  const listenResult = await server.listen();
  expect(listenResult.ok).toBe(true);
  expect(session.start()).toEqual({ ok: true });
  await waitForText(session, 'READY');
});

afterEach(async () => {
  session.kill();
  await server.close();
  session.dispose();
  auth.revoke();
  rmSync(webRoot, { recursive: true, force: true });
});

describe('認証', () => {
  it('認証前はWebSocketに接続できない', async () => {
    await expect(connect(null)).rejects.toThrow(/401/);
  });

  it('無効なトークンでは接続できない', async () => {
    await expect(connect('termwatch_session=invalid-token-value')).rejects.toThrow(/401/);
  });

  it('別OriginからのWebSocket接続を拒否する', async () => {
    const cookie = await pair();
    await expect(
      connect(cookie, { Origin: 'https://evil.example.com' }),
    ).rejects.toThrow(/403/);
  });

  it('Originが無いWebSocket接続を拒否する', async () => {
    const cookie = await pair();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    await expect(
      new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.on('error', reject);
      }),
    ).rejects.toThrow(/403/);
  });

  it('別Originからのペアリング要求を拒否する', async () => {
    const code = auth.getPairingCodeForDisplay() as string;
    const response = await post('/api/pair', { code }, { Origin: 'https://evil.example.com' });
    expect(response.status).toBe(403);
    // コードは消費されていない。
    expect(auth.isPairingActive()).toBe(true);
  });

  it('誤ったペアリングコードを拒否し、レート制限が働く', async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await post('/api/pair', { code: 'ZZZZ-ZZZZ' });
      expect([401, 429]).toContain(response.status);
    }
    const locked = await post('/api/pair', { code: 'ZZZZ-ZZZZ' });
    expect(locked.status).toBe(429);
  });

  it('認証済みクライアントだけが出力を取得できる', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    const snapshot = await client.waitFor('snapshot');
    expect(snapshot.type === 'snapshot' && snapshot.data).toContain('READY');
    client.close();
  });

  it('セキュリティヘッダーを付与する', async () => {
    const response = await fetch(`${origin()}/`);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('閲覧モードと操作モード', () => {
  it('閲覧モードでは直接WebSocketメッセージを送っても入力されない', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    await client.waitFor('snapshot');

    let sawEcho = false;
    session.on('data', (data: string) => {
      if (data.includes('ECHO:侵入')) sawEcho = true;
    });

    client.ws.send(JSON.stringify({ type: 'input.text', text: '侵入', submit: true }));
    client.ws.send(JSON.stringify({ type: 'input.key', key: 'enter' }));

    const error = await client.waitFor('error');
    expect(error.type === 'error' && error.code).toBe('forbidden');
    await sleep(700);
    expect(sawEcho).toBe(false);
    client.close();
  });

  it('操作モードでは入力がPTYへ届く', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    await client.waitFor('snapshot');

    client.ws.send(JSON.stringify({ type: 'control.request' }));
    const control = await client.waitFor('control');
    expect(control.type === 'control' && control.control.mine).toBe(true);

    const echoed = waitForText(session, 'ECHO:こんにちは');
    client.ws.send(JSON.stringify({ type: 'input.text', text: 'こんにちは', submit: true }));
    await echoed;
    client.close();
  });

  it('操作権は1台だけが保持できる', async () => {
    const cookie = await pair();
    const first = await connect(cookie);
    const second = await connect(cookie);
    first.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    second.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    await first.waitFor('snapshot');
    await second.waitFor('snapshot');

    first.ws.send(JSON.stringify({ type: 'control.request' }));
    const granted = await first.waitFor('control');
    expect(granted.type === 'control' && granted.control.mine).toBe(true);

    second.ws.send(JSON.stringify({ type: 'control.request' }));
    const denied = await second.waitUntil(
      (m) => m.type === 'control' && m.reason === 'denied-busy',
    );
    expect(denied.type === 'control' && denied.control.mine).toBe(false);

    first.close();
    second.close();
  });

  it('不正なメッセージでもサーバーと子プロセスが落ちない', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    client.ws.send('壊れたJSON');
    client.ws.send(JSON.stringify({ type: 'unknown' }));
    client.ws.send(JSON.stringify({ type: 'input.key', key: 'ctrl-alt-del' }));
    await sleep(300);
    expect(session.isAlive).toBe(true);

    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    await client.waitFor('snapshot');
    client.close();
  });

  it('resume の繰り返しを拒否する（スナップショット連打によるDoS対策）', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    const closed = new Promise<number>((resolve) =>
      client.ws.on('close', (code: number) => resolve(code)),
    );
    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    await client.waitFor('snapshot');
    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    expect(await closed).toBe(1008);
    expect(session.isAlive).toBe(true);
  });

  it('64KiBを超えるテキストを拒否する', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    await client.waitFor('snapshot');

    // エンベロープ上限内、かつテキスト上限（64KiB）超過。
    client.ws.send(JSON.stringify({ type: 'input.text', text: 'x'.repeat(66_000), submit: true }));
    const error = await client.waitFor('error');
    expect(error.type === 'error' && error.code).toBe('too-large');
    expect(session.isAlive).toBe(true);
    client.close();
  });

  it('WebSocketフレーム上限を超える送信で接続を閉じても子プロセスは継続する', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    const closed = new Promise<void>((resolve) => client.ws.on('close', () => resolve()));
    client.ws.send(JSON.stringify({ type: 'input.text', text: 'x'.repeat(200_000), submit: true }));
    await closed;
    expect(session.isAlive).toBe(true);
  });
});

describe('出力配信と再接続', () => {
  it('スナップショットの後にライブ出力が続き、重複しない', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    const snapshot = await client.waitFor('snapshot');
    const snapshotSeq = snapshot.type === 'snapshot' ? snapshot.seq : 0;

    session.write('あとから\r');
    await waitForText(session, 'ECHO:あとから');
    await sleep(300);

    const outputs = client.messages.filter((m) => m.type === 'output');
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) {
      if (output.type === 'output') expect(output.seq).toBeGreaterThan(snapshotSeq);
    }
    client.close();
  });

  it('再接続時に受信済み以降だけを受け取る', async () => {
    const cookie = await pair();
    const first = await connect(cookie);
    first.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    const snapshot = await first.waitFor('snapshot');
    const seq = snapshot.type === 'snapshot' ? snapshot.seq : 0;
    first.close();
    await sleep(200);

    session.write('切断中の出力\r');
    await waitForText(session, 'ECHO:切断中の出力');

    const second = await connect(cookie);
    second.ws.send(JSON.stringify({ type: 'resume', lastSeq: seq, controlHandle: null }));
    const resumed = await second.waitFor('snapshot');
    expect(resumed.type === 'snapshot' && resumed.data).toContain('ECHO:切断中の出力');
    expect(resumed.type === 'snapshot' && resumed.data).not.toContain('READY');
    second.close();
  });

  it('WebSocket切断後も子プロセスは動き続ける', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    await client.waitFor('snapshot');
    client.close();
    await sleep(300);

    expect(session.isAlive).toBe(true);
    session.write('生存確認\r');
    await waitForText(session, 'ECHO:生存確認');
  });

  it('操作権は60秒以内の再接続で引き継げる', async () => {
    const cookie = await pair();
    const first = await connect(cookie);
    first.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    await first.waitFor('snapshot');
    first.ws.send(JSON.stringify({ type: 'control.request' }));
    const granted = await first.waitFor('control');
    const handle =
      granted.type === 'control' ? (granted.control.handle ?? null) : null;
    expect(handle).not.toBeNull();
    first.close();
    await sleep(300);

    const second = await connect(cookie);
    second.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: handle }));
    const control = await second.waitFor('control');
    expect(control.type === 'control' && control.control.mine).toBe(true);
    second.close();
  });

  it('子プロセス終了時に終了コードを通知する', async () => {
    const cookie = await pair();
    const client = await connect(cookie);
    client.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    await client.waitFor('snapshot');

    session.write('EXIT:7\r');
    await sleep(2000);

    const statuses = client.messages.filter((m) => m.type === 'status');
    const last = statuses[statuses.length - 1];
    expect(last?.type === 'status' && last.status.process).toBe('exited');
    expect(last?.type === 'status' && last.status.exitCode).toBe(7);
    client.close();
  });
});

describe('バッファ上限', () => {
  it('破棄が起きた後の再接続で truncated を通知する', async () => {
    // 既定の設定はバッファが大きく溢れないため、小さいバッファで作り直す。
    session.kill();
    await server.close();
    session.dispose();

    const smallBuffer = 5;
    port = await freePort();
    session = new PtySession({
      command: process.execPath,
      args: [CHILD],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      bufferLines: smallBuffer,
      recordPath: null,
    });
    auth = new SessionAuth();
    server = new TermWatchServer({
      port,
      webRoot,
      auth,
      session,
      controlMinutes: 10,
      bufferLines: smallBuffer,
      version: 'test',
    });
    expect((await server.listen()).ok).toBe(true);
    expect(session.start()).toEqual({ ok: true });
    await waitForText(session, 'READY');

    const cookie = await pair();
    const first = await connect(cookie);
    first.ws.send(JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: null }));
    const snapshot = await first.waitFor('snapshot');
    const seq = snapshot.type === 'snapshot' ? snapshot.seq : 0;
    first.close();
    await sleep(200);

    // 切断中に上限を大きく超える出力を発生させる。
    for (let i = 0; i < 60; i += 1) session.write(`行${i}\r`);
    await waitForText(session, 'ECHO:行59');
    await sleep(300);

    const second = await connect(cookie);
    second.ws.send(JSON.stringify({ type: 'resume', lastSeq: seq, controlHandle: null }));
    const resumed = await second.waitFor('snapshot');
    // 欠落を隠さずクライアントへ伝えること。
    expect(resumed.type === 'snapshot' && resumed.truncated).toBe(true);
    // 直近の出力は残っていること。
    expect(resumed.type === 'snapshot' && resumed.data).toContain('行59');
    second.close();
  });
});
