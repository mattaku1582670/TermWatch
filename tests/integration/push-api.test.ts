import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtySession } from '../../src/pty/session.js';
import { SessionAuth } from '../../src/security/tokens.js';
import { TermWatchServer } from '../../src/server/server.js';
import { parseSubscription } from '../../src/notify/subscription-store.js';

const CHILD = fileURLToPath(new URL('../fixtures/echo-child.mjs', import.meta.url));

let webRoot: string;
let port: number;
let session: PtySession;
let auth: SessionAuth;
let server: TermWatchServer;
let pushCalls: unknown[];

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

  pushCalls = [];
  const fakePush = {
    publicKey: 'test-public-key',
    subscribe(input: unknown): boolean {
      const record = parseSubscription(input);
      if (record === null) return false;
      pushCalls.push(record);
      return true;
    },
    unsubscribe(): void {},
  };

  server = new TermWatchServer({
    port,
    webRoot,
    auth,
    session,
    controlMinutes: 10,
    bufferLines: 1000,
    version: 'test',
    push: fakePush,
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

/**
 * 購読API。
 *
 * 購読情報は「その端末へ通知を送れる資格」そのもの。
 * 認証前に登録・取得できてはならない。
 */
describe('購読API', () => {
  it('認証前は公開鍵を取得できない', async () => {
    const response = await fetch(`${origin()}/api/push/key`, { headers: { Origin: origin() } });
    expect(response.status).toBe(401);
  });

  it('認証前は購読できない', async () => {
    const response = await post('/api/push/subscribe', {
      endpoint: 'https://web.push.apple.com/abc',
      keys: { p256dh: 'a', auth: 'b' },
    });
    expect(response.status).toBe(401);
  });

  it('認証済みなら公開鍵を取得できる', async () => {
    const cookie = await pair();
    const response = await fetch(`${origin()}/api/push/key`, {
      headers: { Origin: origin(), Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { publicKey?: unknown };
    expect(body.publicKey).toBe('test-public-key');
  });

  it('Origin が違えば拒否する', async () => {
    const cookie = await pair();
    const response = await fetch(`${origin()}/api/push/key`, {
      headers: { Origin: 'https://evil.example', Cookie: cookie },
    });
    expect(response.status).toBe(403);
  });

  it('壊れた購読情報を拒否する', async () => {
    const cookie = await pair();
    const response = await post('/api/push/subscribe', { endpoint: 'not-a-url' }, { Cookie: cookie });
    expect(response.status).toBe(400);
  });

  it('購読と解除ができる', async () => {
    const cookie = await pair();
    const subscription = {
      endpoint: 'https://web.push.apple.com/abc',
      keys: { p256dh: 'p', auth: 'a' },
    };
    const added = await post('/api/push/subscribe', subscription, { Cookie: cookie });
    expect(added.status).toBe(204);
    expect(pushCalls).toHaveLength(1);

    const removed = await fetch(`${origin()}/api/push/subscribe`, {
      method: 'DELETE',
      headers: { Origin: origin(), Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    expect(removed.status).toBe(204);
  });
});

/**
 * クライアントが本文送信の途中でソケットを切断した場合の挙動。
 *
 * `IncomingMessage` は購読者のいない `error` を発火すると EventEmitter の
 * 仕様で例外を再スローする。これによりプロセス全体が落ちないこと（＝
 * サーバーがその後も応答を返せること）を確認する。
 */
describe('本文読み取り中の切断', () => {
  /**
   * 宣言した Content-Length より少ないバイト数だけ送ってからソケットを
   * 破棄する。サーバー側は本文の続きを待っている状態のまま接続が切れるため、
   * `IncomingMessage` の `error`（ECONNRESET相当）が発火する。
   */
  async function sendPartialBodyThenDestroy(
    path: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('error', () => {
        // クライアント側ソケットの後始末時に出るエラーは無視する。
        resolve();
      });
      socket.once('connect', () => {
        const bodyStart = '{"endpoint":"https://example.com/partial"';
        const headerLines = [
          `POST ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Origin: ${origin()}`,
          'Content-Type: application/json',
          // 実際に送るバイト数より大きく宣言し、サーバーに続きを待たせる。
          'Content-Length: 999',
          ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
          '',
          '',
        ];
        socket.write(headerLines.join('\r\n') + bodyStart, (err) => {
          if (err) {
            reject(err);
            return;
          }
          socket.destroy();
          resolve();
        });
      });
    });
  }

  it('/api/push/subscribe への本文送信中に切断してもサーバーが落ちない', async () => {
    const cookie = await pair();
    await sendPartialBodyThenDestroy('/api/push/subscribe', { Cookie: cookie });

    // サーバープロセスが例外で落ちていれば、以降のリクエストはすべて失敗する。
    const response = await fetch(`${origin()}/api/push/key`, {
      headers: { Origin: origin(), Cookie: cookie },
    });
    expect(response.status).toBe(200);
  });

  it('/api/pair への本文送信中に切断してもサーバーが落ちない', async () => {
    await sendPartialBodyThenDestroy('/api/pair');

    // サーバープロセスが例外で落ちていなければ、通常どおりペアリングできる。
    const cookie = await pair();
    expect(cookie).toContain('termwatch_session=');
  });
});

describe('CSP', () => {
  it('Service Worker と manifest を許可する', async () => {
    const response = await fetch(`${origin()}/`, { headers: { Origin: origin() } });
    const csp = response.headers.get('content-security-policy') ?? '';
    // default-src 'none' のままでは、どちらも読み込めない。
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
  });
});
