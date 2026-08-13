import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configDir } from '../../src/notify/paths.js';
import {
  SubscriptionStore,
  parseSubscription,
} from '../../src/notify/subscription-store.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termwatch-sub-'));
  file = join(dir, 'subscriptions.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sample = {
  endpoint: 'https://web.push.apple.com/abc',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
};

describe('parseSubscription', () => {
  it('必要な項目がそろっていれば受理する', () => {
    expect(parseSubscription(sample)).toEqual(sample);
  });

  it('項目が欠けていれば拒否する', () => {
    expect(parseSubscription({ endpoint: 'https://x' })).toBeNull();
    expect(parseSubscription({ ...sample, keys: { p256dh: 'a' } })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
    expect(parseSubscription('文字列')).toBeNull();
  });

  it('http や不正なURLは拒否する', () => {
    // 購読先は必ず HTTPS。平文の宛先を保存しない。
    expect(parseSubscription({ ...sample, endpoint: 'http://web.push.apple.com/a' })).toBeNull();
    expect(parseSubscription({ ...sample, endpoint: 'not-a-url' })).toBeNull();
  });

  it('極端に長い値は拒否する', () => {
    expect(parseSubscription({ ...sample, endpoint: `https://x/${'a'.repeat(4000)}` })).toBeNull();
  });
});

describe('SubscriptionStore', () => {
  it('保存した内容を読み戻せる', () => {
    const store = new SubscriptionStore(file);
    store.add(sample);
    expect(new SubscriptionStore(file).list()).toEqual([sample]);
  });

  it('同じ endpoint は重複させない', () => {
    const store = new SubscriptionStore(file);
    store.add(sample);
    store.add({ ...sample, keys: { p256dh: 'new', auth: 'new' } });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.keys.p256dh).toBe('new');
  });

  it('削除できる', () => {
    const store = new SubscriptionStore(file);
    store.add(sample);
    store.remove(sample.endpoint);
    expect(store.list()).toEqual([]);
  });

  it('所有者だけが読める権限で作る', () => {
    const store = new SubscriptionStore(file);
    store.add(sample);
    // Windows では POSIX 権限が反映されないため、存在確認のみ行う。
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
    else expect(mode).toBeGreaterThan(0);
  });

  it('読めないファイルは空として扱い、例外を投げない', () => {
    const store = new SubscriptionStore(join(dir, 'missing.json'));
    expect(store.list()).toEqual([]);
  });
});

describe('configDir', () => {
  it('APPDATA の下へ置く', () => {
    const path = configDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } as NodeJS.ProcessEnv);
    expect(path).toContain('TermWatch');
  });

  it('APPDATA が無ければホームの下へ置く', () => {
    const path = configDir({} as NodeJS.ProcessEnv);
    expect(path).toContain('.termwatch');
  });
});
