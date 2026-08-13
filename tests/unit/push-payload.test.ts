import { describe, expect, it, vi } from 'vitest';
import { buildIdlePayload } from '../../src/notify/push-sender.js';
import type { SubscriptionStore } from '../../src/notify/subscription-store.js';

/**
 * 通知本文。
 *
 * 設計上の約束はひとつ、「ターミナルの内容を含めない」。
 * 本文は端末間で暗号化されるが、内容が PC の外へ出ることに変わりはない。
 */
describe('buildIdlePayload', () => {
  it('コマンド名と経過時間を出す', () => {
    const payload = buildIdlePayload('codex', 30_000);
    expect(payload.title).toBe('TermWatch');
    expect(payload.body).toBe('codex の出力が30秒止まっています');
  });

  it('1分以上は分と秒で出す', () => {
    expect(buildIdlePayload('codex', 90_000).body).toBe('codex の出力が1分30秒止まっています');
  });

  it('長いコマンド名は切り詰める', () => {
    const payload = buildIdlePayload(`codex ${'x'.repeat(200)}`, 30_000);
    expect(payload.body.length).toBeLessThan(120);
  });

  it('受け取れるのはコマンド名だけで、出力を渡す口が無い', () => {
    const payload = buildIdlePayload('codex resume --last', 30_000);
    expect(payload.body).toBe('codex resume --last の出力が30秒止まっています');
  });
});

/**
 * 送信失敗時に購読情報が漏れないこと。
 * 購読情報は「その端末へ通知を送れる資格」そのものなので、
 * 例外の内容をそのまま出力してはならない。
 */
describe('送信失敗時の扱い', () => {
  it('失効した購読を取り除き、内容を出力しない', async () => {
    // web-push は CommonJS のため vi.spyOn(webpush, 'sendNotification') では
    // spy を張れない（setVapidDetails が実鍵検証で先に例外を投げる）。
    // brief の判断基準に従い、モジュールごと差し替える。
    vi.doMock('web-push', () => ({
      default: {
        setVapidDetails: vi.fn(),
        sendNotification: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 })),
      },
    }));
    vi.resetModules();

    const { PushSender } = await import('../../src/notify/push-sender.js');

    const removed: string[] = [];
    const store = {
      list: () => [{ endpoint: 'https://web.push.apple.com/gone', keys: { p256dh: 'p', auth: 'a' } }],
      add: () => {},
      remove: (endpoint: string) => removed.push(endpoint),
    } as unknown as SubscriptionStore;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const sender = new PushSender({ publicKey: 'pub', privateKey: 'priv' }, store);
    await sender.send({ title: 'T', body: 'B' });

    expect(removed).toEqual(['https://web.push.apple.com/gone']);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    vi.doUnmock('web-push');
    vi.resetModules();
  });
});
