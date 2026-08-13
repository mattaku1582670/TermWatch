# プッシュ通知 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子プロセスの出力が既定30秒止まったら、iPhone へ Web Push で通知する。

**Architecture:** 出力停止を検知する `IdleWatcher`、購読情報を永続化する `SubscriptionStore`、
Web Push を送る `PushSender` の3モジュールを `src/notify/` に新設する。
既存の `PtySession` / `TermWatchServer` / `main.ts` への変更は接続部分に限る。
スマートフォン側は PWA（manifest + Service Worker）として通知を受け取る。

**Tech Stack:** TypeScript (strict), Node.js 24, vitest, Vite, `web-push`

## Global Constraints

設計書 `docs/superpowers/specs/2026-08-13-push-notification-design.md` に加え、
本リポジトリで常に守る制約。違反する実装は不可。

- バインドアドレスは `127.0.0.1` 固定。`0.0.0.0` や LAN IP へ広げない。フォールバックも作らない
- 平文のトークン・ペアリングコード・購読情報・VAPID 秘密鍵を、ログ／URL／エラー出力へ出さない
- 通知本文にターミナルの内容を含めない
- PTY 出力をディスクへ書かない（`--record` 指定時のみ。本機能で例外を作らない）
- 独自の中継サーバーを作らない。送信先は購読情報に含まれるプッシュ網のみ
- Web UI へ未エスケープの HTML を差し込まない
- 購読 API は既存のセッション認証と Origin 検証を必ず通す
- コメントと利用者向け文言は日本語。既存ファイルの記述密度に合わせる
- 各タスクの最後に `npm run lint && npm run typecheck && npm test` が通ること

---

## ファイル構成

**新規作成**

| ファイル | 責務 |
|---|---|
| `src/notify/paths.ts` | 設定ファイルの置き場所を決める |
| `src/notify/idle-watcher.ts` | 出力停止の検知 |
| `src/notify/subscription-store.ts` | 購読情報の永続化 |
| `src/notify/push-sender.ts` | VAPID 鍵の管理と送信、通知本文の組み立て |
| `src/notify/push-service.ts` | 上記をまとめ、サーバーへ渡す薄い口 |
| `web/public/manifest.json` | ホーム画面追加用 |
| `web/public/sw.js` | Service Worker |
| `scripts/make-icons.mjs` | アイコン PNG の生成 |
| `tests/unit/idle-watcher.test.ts` | Task 1 の試験 |
| `tests/unit/subscription-store.test.ts` | Task 2 の試験 |
| `tests/unit/push-payload.test.ts` | Task 3 の試験 |
| `tests/integration/push-api.test.ts` | Task 5 の試験 |

**変更**

| ファイル | 変更点 |
|---|---|
| `src/cli/args.ts` | `--notify-idle-seconds` / `--no-notify` |
| `src/cli/banner.ts` | 起動バナーへ通知の状態を出す |
| `src/cli/main.ts` | 各モジュールの組み立てと接続 |
| `src/server/server.ts` | 購読 API 3本、CSP に `worker-src` / `manifest-src`、接続数の公開 |
| `web/index.html` | manifest への link、通知トグル |
| `web/src/main.ts` | Service Worker 登録と購読処理 |
| `package.json` | `web-push` 追加、`icons` スクリプト |

---

### Task 1: 出力停止の検知

**Files:**
- Create: `src/notify/idle-watcher.ts`
- Test: `tests/unit/idle-watcher.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `export interface IdleWatcherOptions { readonly idleMs: number; readonly onIdle: () => void }`
  - `export class IdleWatcher { constructor(options: IdleWatcherOptions); noteOutput(): void; stop(): void }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/idle-watcher.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleWatcher } from '../../src/notify/idle-watcher.js';

/**
 * 出力停止の検知。
 *
 * 通知の唯一の欠点が誤報なので、1つの静止期間につき1回だけ発火することを固定する。
 */
describe('IdleWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('しきい値に達したら発火する', () => {
    const onIdle = vi.fn();
    const watcher = new IdleWatcher({ idleMs: 30_000, onIdle });
    watcher.noteOutput();
    vi.advanceTimersByTime(29_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('出力があるたびに数え直す', () => {
    const onIdle = vi.fn();
    const watcher = new IdleWatcher({ idleMs: 30_000, onIdle });
    watcher.noteOutput();
    vi.advanceTimersByTime(20_000);
    watcher.noteOutput();
    vi.advanceTimersByTime(20_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('1つの静止期間では1回しか発火しない', () => {
    const onIdle = vi.fn();
    const watcher = new IdleWatcher({ idleMs: 30_000, onIdle });
    watcher.noteOutput();
    vi.advanceTimersByTime(120_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('出力が再開すれば次の静止でまた発火する', () => {
    const onIdle = vi.fn();
    const watcher = new IdleWatcher({ idleMs: 30_000, onIdle });
    watcher.noteOutput();
    vi.advanceTimersByTime(40_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watcher.noteOutput();
    vi.advanceTimersByTime(40_000);
    expect(onIdle).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('stop 後は発火しない', () => {
    const onIdle = vi.fn();
    const watcher = new IdleWatcher({ idleMs: 30_000, onIdle });
    watcher.noteOutput();
    watcher.stop();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('出力が一度も無ければ発火しない', () => {
    const onIdle = vi.fn();
    const watcher = new IdleWatcher({ idleMs: 30_000, onIdle });
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    watcher.stop();
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run tests/unit/idle-watcher.test.ts`
Expected: FAIL（`src/notify/idle-watcher.js` が存在しない）

- [ ] **Step 3: 実装する**

`src/notify/idle-watcher.ts`:

```ts
/**
 * 子プロセスの出力が止まったことの検知。
 *
 * 出力のたびにタイマーを張り直し、しきい値に達したら1度だけ知らせる。
 * 出力が再開するまで再通知しないのは、誤報を増やさないため
 * （通知の唯一の欠点が誤報である）。
 *
 * UI の「出力停止中」判定（IDLE_THRESHOLD_MS = 3秒）とは別物。
 * 3秒は入力を考えている間にも成立するため、通知には短すぎる。
 */

export interface IdleWatcherOptions {
  /** この時間だけ出力が無ければ知らせる。 */
  readonly idleMs: number;
  readonly onIdle: () => void;
}

export class IdleWatcher {
  private timer: NodeJS.Timeout | null = null;
  /** 今の静止期間で既に知らせたか。 */
  private fired = false;
  private stopped = false;

  constructor(private readonly options: IdleWatcherOptions) {}

  /** 出力があったことを伝える。 */
  noteOutput(): void {
    if (this.stopped) return;
    this.fired = false;
    this.arm();
  }

  /** 監視を終える。多重呼び出し安全。 */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private arm(): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.fired) return;
      this.fired = true;
      this.options.onIdle();
    }, this.options.idleMs);
    // 通知のためだけにプロセスを生かし続けない。
    this.timer.unref?.();
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: 成功を確認する**

Run: `npx vitest run tests/unit/idle-watcher.test.ts`
Expected: PASS（6件）

- [ ] **Step 5: 検証してコミットする**

```bash
npm run lint && npm run typecheck && npm test
git add src/notify/idle-watcher.ts tests/unit/idle-watcher.test.ts
git commit -m "出力停止を検知する IdleWatcher を追加"
```

---

### Task 2: 購読情報の永続化

**Files:**
- Create: `src/notify/paths.ts`, `src/notify/subscription-store.ts`
- Test: `tests/unit/subscription-store.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `export function configDir(env?: NodeJS.ProcessEnv): string`
  - `export interface PushSubscriptionRecord { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } }`
  - `export function parseSubscription(input: unknown): PushSubscriptionRecord | null`
  - `export class SubscriptionStore { constructor(filePath: string); list(): PushSubscriptionRecord[]; add(record: PushSubscriptionRecord): void; remove(endpoint: string): void }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/subscription-store.test.ts`:

```ts
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
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run tests/unit/subscription-store.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: `src/notify/paths.ts` を実装する**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 設定ファイルの置き場所。
 *
 * TermWatch にとって初めての永続状態になる。置くのは VAPID 鍵と購読情報だけで、
 * ターミナルの内容は一切保存しない（--record の方針は変えない）。
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env['APPDATA'];
  if (typeof appData === 'string' && appData.length > 0) {
    return join(appData, 'TermWatch');
  }
  return join(homedir(), '.termwatch');
}
```

- [ ] **Step 4: `src/notify/subscription-store.ts` を実装する**

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * プッシュ購読情報の永続化。
 *
 * 購読情報は「その端末へ通知を送れる資格」そのもの。
 * 権限を所有者のみに絞り、ログ・エラー出力へ一切出さない。
 */

/** endpoint と鍵の長さ上限。壊れた入力や肥大化を防ぐ。 */
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** 受け取った購読情報を検証する。信用できない入力として扱う。 */
export function parseSubscription(input: unknown): PushSubscriptionRecord | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;

  const endpoint = record['endpoint'];
  if (!isNonEmptyString(endpoint, MAX_ENDPOINT_LENGTH)) return null;
  try {
    // 平文の宛先は保存しない。
    if (new URL(endpoint).protocol !== 'https:') return null;
  } catch {
    return null;
  }

  const keys = record['keys'];
  if (typeof keys !== 'object' || keys === null) return null;
  const keyRecord = keys as Record<string, unknown>;
  const p256dh = keyRecord['p256dh'];
  const auth = keyRecord['auth'];
  if (!isNonEmptyString(p256dh, MAX_KEY_LENGTH)) return null;
  if (!isNonEmptyString(auth, MAX_KEY_LENGTH)) return null;

  return { endpoint, keys: { p256dh, auth } };
}

export class SubscriptionStore {
  constructor(private readonly filePath: string) {}

  /** 保存済みの購読を返す。読めない場合は空として扱う。 */
  list(): PushSubscriptionRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const result: PushSubscriptionRecord[] = [];
      for (const item of parsed) {
        const record = parseSubscription(item);
        if (record !== null) result.push(record);
      }
      return result;
    } catch {
      // 壊れていても機能を止めない。通知は付随機能である。
      return [];
    }
  }

  add(record: PushSubscriptionRecord): void {
    const next = this.list().filter((item) => item.endpoint !== record.endpoint);
    next.push(record);
    this.save(next);
  }

  remove(endpoint: string): void {
    this.save(this.list().filter((item) => item.endpoint !== endpoint));
  }

  private save(records: readonly PushSubscriptionRecord[]): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(records), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // 保存できなくても TermWatch 本体は止めない。内容はログへ出さない。
    }
  }
}
```

- [ ] **Step 5: 成功を確認する**

Run: `npx vitest run tests/unit/subscription-store.test.ts`
Expected: PASS（11件）

- [ ] **Step 6: 検証してコミットする**

```bash
npm run lint && npm run typecheck && npm test
git add src/notify/paths.ts src/notify/subscription-store.ts tests/unit/subscription-store.test.ts
git commit -m "プッシュ購読情報の永続化を追加"
```

---

### Task 3: 通知本文の組み立てと送信

**Files:**
- Create: `src/notify/push-sender.ts`
- Test: `tests/unit/push-payload.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `SubscriptionStore`, `PushSubscriptionRecord`（Task 2）
- Produces:
  - `export interface NotificationPayload { readonly title: string; readonly body: string }`
  - `export function buildIdlePayload(command: string, idleMs: number): NotificationPayload`
  - `export interface VapidKeys { readonly publicKey: string; readonly privateKey: string }`
  - `export function loadOrCreateVapidKeys(filePath: string): VapidKeys`
  - `export class PushSender { constructor(keys: VapidKeys, store: SubscriptionStore); get publicKey(): string; send(payload: NotificationPayload): Promise<void> }`

- [ ] **Step 1: `web-push` を追加する**

```bash
npm install web-push
npm install --save-dev @types/web-push
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/unit/push-payload.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildIdlePayload } from '../../src/notify/push-sender.js';

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
    const { PushSender } = await import('../../src/notify/push-sender.js');
    const webpush = (await import('web-push')).default;

    const removed: string[] = [];
    const store = {
      list: () => [{ endpoint: 'https://web.push.apple.com/gone', keys: { p256dh: 'p', auth: 'a' } }],
      add: () => {},
      remove: (endpoint: string) => removed.push(endpoint),
    } as unknown as SubscriptionStore;

    vi.spyOn(webpush, 'sendNotification').mockRejectedValue(
      Object.assign(new Error('gone'), { statusCode: 410 }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const sender = new PushSender({ publicKey: 'pub', privateKey: 'priv' }, store);
    await sender.send({ title: 'T', body: 'B' });

    expect(removed).toEqual(['https://web.push.apple.com/gone']);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
```

この試験では `vi` と `SubscriptionStore` 型も import する。
先頭の import 行を次に差し替えること。

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildIdlePayload } from '../../src/notify/push-sender.js';
import type { SubscriptionStore } from '../../src/notify/subscription-store.js';
```

`loadOrCreateVapidKeys` は実鍵の生成に時間がかかるため単体試験では呼ばない。
鍵の読み書きは手動確認 MT-18 で確認する。

- [ ] **Step 3: 失敗を確認する**

Run: `npx vitest run tests/unit/push-payload.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 4: 実装する**

`src/notify/push-sender.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import webpush from 'web-push';
import type { PushSubscriptionRecord, SubscriptionStore } from './subscription-store.js';

/**
 * Web Push の送信。
 *
 * 本文は端末間で暗号化され、配信網の運営者にも読めない。
 * それでも内容が PC の外へ出ることに変わりはないため、
 * 本文にはコマンド名と経過時間しか載せない（ターミナルの内容は含めない）。
 */

/** 通知本文へ載せるコマンド名の上限。 */
const MAX_COMMAND_LENGTH = 60;
/** VAPID の連絡先。実在のアドレスを持たないためローカルを指す。 */
const VAPID_SUBJECT = 'mailto:termwatch@localhost';

export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
}

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}秒`;
  return `${minutes}分${seconds}秒`;
}

/** 出力停止の通知本文を組み立てる。ターミナルの内容は受け取らない。 */
export function buildIdlePayload(command: string, idleMs: number): NotificationPayload {
  const name =
    command.length > MAX_COMMAND_LENGTH ? `${command.slice(0, MAX_COMMAND_LENGTH)}…` : command;
  return {
    title: 'TermWatch',
    body: `${name} の出力が${formatDuration(idleMs)}止まっています`,
  };
}

/**
 * VAPID 鍵を読み込む。無ければ生成して保存する。
 * 秘密鍵はスマートフォンへ渡さず、ログにも出さない。
 */
export function loadOrCreateVapidKeys(filePath: string): VapidKeys {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const publicKey = record['publicKey'];
      const privateKey = record['privateKey'];
      if (typeof publicKey === 'string' && typeof privateKey === 'string') {
        return { publicKey, privateKey };
      }
    }
  } catch {
    // 読めなければ作り直す。
  }

  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(keys), { encoding: 'utf8', mode: 0o600 });
  return keys;
}

export class PushSender {
  constructor(
    private readonly keys: VapidKeys,
    private readonly store: SubscriptionStore,
  ) {
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  /**
   * 購読中のすべての端末へ送る。
   * 失効した購読（404/410）は保存先から取り除く。
   */
  async send(payload: NotificationPayload): Promise<void> {
    const subscriptions = this.store.list();
    if (subscriptions.length === 0) return;

    const body = JSON.stringify(payload);
    await Promise.all(
      subscriptions.map(async (subscription: PushSubscriptionRecord) => {
        try {
          await webpush.sendNotification(subscription, body);
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.store.remove(subscription.endpoint);
          }
          // 送信失敗の詳細は出さない。購読情報が混ざるため。
        }
      }),
    );
  }
}
```

- [ ] **Step 5: 成功を確認する**

Run: `npx vitest run tests/unit/push-payload.test.ts`
Expected: PASS（5件）

- [ ] **Step 6: 検証してコミットする**

```bash
npm run lint && npm run typecheck && npm test
git add package.json package-lock.json src/notify/push-sender.ts tests/unit/push-payload.test.ts
git commit -m "Web Push の送信と通知本文の組み立てを追加"
```

---

### Task 4: CLI オプション

**Files:**
- Modify: `src/cli/args.ts`
- Test: `tests/unit/args.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `ParsedOptions` に `readonly notify: boolean` と `readonly notifyIdleSeconds: number` を追加

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/args.test.ts` の末尾へ追加する（`parseArgs` は既に import 済み）:

```ts
describe('通知オプション', () => {
  it('既定は有効で30秒', () => {
    const result = parseArgs(['--', 'codex']);
    if (result.kind !== 'run') throw new Error('run ではない');
    expect(result.options.notify).toBe(true);
    expect(result.options.notifyIdleSeconds).toBe(30);
  });

  it('--no-notify で無効になる', () => {
    const result = parseArgs(['--no-notify', '--', 'codex']);
    if (result.kind !== 'run') throw new Error('run ではない');
    expect(result.options.notify).toBe(false);
  });

  it('--notify-idle-seconds で変更できる', () => {
    const result = parseArgs(['--notify-idle-seconds', '60', '--', 'codex']);
    if (result.kind !== 'run') throw new Error('run ではない');
    expect(result.options.notifyIdleSeconds).toBe(60);
  });

  it('範囲外や数値でない値は使い方エラーにする', () => {
    expect(parseArgs(['--notify-idle-seconds', '0', '--', 'codex']).kind).toBe('error');
    expect(parseArgs(['--notify-idle-seconds', 'abc', '--', 'codex']).kind).toBe('error');
    expect(parseArgs(['--notify-idle-seconds', '99999', '--', 'codex']).kind).toBe('error');
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run tests/unit/args.test.ts`
Expected: FAIL（`notify` が存在しない）

- [ ] **Step 3: 実装する**

`src/cli/args.ts` の `ParsedOptions` へ追加する。

```ts
  /** 出力停止時にスマートフォンへ通知するか。 */
  readonly notify: boolean;
  /** 通知までの静止時間（秒）。 */
  readonly notifyIdleSeconds: number;
```

既定値を保持する変数へ `let notify = true;` `let notifyIdleSeconds = 30;` を加え、
戻り値の `options` へ両方を含める。解析部は `--port` と同じ書き方に合わせる。
上限は1時間とする。

```ts
    if (arg === '--no-notify') {
      notify = false;
      continue;
    }
    if (arg === '--notify-idle-seconds') {
      const raw = argv[index + 1];
      index += 1;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 3600) {
        return {
          kind: 'error',
          message: '--notify-idle-seconds は1〜3600の整数で指定してください。',
        };
      }
      notifyIdleSeconds = value;
      continue;
    }
```

`HELP_TEXT` のオプション一覧へ次の2行を追加する。

```
  --notify-idle-seconds <秒> 出力停止から通知までの時間（既定: 30）
  --no-notify               スマートフォンへの通知を無効化する
```

- [ ] **Step 4: 成功を確認する**

Run: `npx vitest run tests/unit/args.test.ts`
Expected: PASS

- [ ] **Step 5: 検証してコミットする**

```bash
npm run lint && npm run typecheck && npm test
git add src/cli/args.ts tests/unit/args.test.ts
git commit -m "通知の CLI オプションを追加"
```

---

### Task 5: 購読 API と CSP

**Files:**
- Create: `src/notify/push-service.ts`
- Modify: `src/server/server.ts`
- Test: `tests/integration/push-api.test.ts`

**Interfaces:**
- Consumes: `PushSender`（Task 3）, `parseSubscription` / `SubscriptionStore`（Task 2）
- Produces:
  - `export interface PushService { readonly publicKey: string; subscribe(input: unknown): boolean; unsubscribe(endpoint: string): void }`
  - `export function createPushService(sender: PushSender, store: SubscriptionStore): PushService`
  - `ServerOptions` に `readonly push?: PushService | null`
  - `TermWatchServer` に `get activeClientCount(): number`

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/push-api.test.ts` を作る。
`tests/integration/server.test.ts` の先頭150行（import、`freePort`、`origin`、`post`、
`pair`、`beforeEach`、`afterEach`）を読み、同じ組み立てを複製すること。
`beforeEach` の `TermWatchServer` 生成へ、次の偽の `push` を渡す。

```ts
const pushCalls: unknown[] = [];
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
```

試験本体:

```ts
/**
 * 購読 API。
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

describe('CSP', () => {
  it('Service Worker と manifest を許可する', async () => {
    const response = await fetch(`${origin()}/`, { headers: { Origin: origin() } });
    const csp = response.headers.get('content-security-policy') ?? '';
    // default-src 'none' のままでは、どちらも読み込めない。
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx vitest run tests/integration/push-api.test.ts`
Expected: FAIL（404 と CSP の不足）

- [ ] **Step 3: `src/notify/push-service.ts` を実装する**

```ts
import type { PushSender } from './push-sender.js';
import { parseSubscription, type SubscriptionStore } from './subscription-store.js';

/**
 * サーバーへ渡す薄い口。
 *
 * サーバーが購読の保存方法や送信手段を知らずに済むよう、必要な操作だけを見せる。
 */
export interface PushService {
  readonly publicKey: string;
  /** 購読を登録する。入力が不正なら false。 */
  subscribe(input: unknown): boolean;
  unsubscribe(endpoint: string): void;
}

export function createPushService(sender: PushSender, store: SubscriptionStore): PushService {
  return {
    publicKey: sender.publicKey,
    subscribe(input: unknown): boolean {
      const record = parseSubscription(input);
      if (record === null) return false;
      store.add(record);
      return true;
    },
    unsubscribe(endpoint: string): void {
      store.remove(endpoint);
    },
  };
}
```

- [ ] **Step 4: `src/server/server.ts` を変更する**

1. `import type { PushService } from '../notify/push-service.js';` を加える。

2. `ServerOptions` へ追加する。

```ts
  /** 未指定なら購読APIを提供しない（通知を無効化した場合）。 */
  readonly push?: PushService | null;
```

3. `securityHeaders` の CSP 配列へ2行加える。`default-src 'none'` のままでは
   Service Worker も manifest も読み込めない。

```ts
        "worker-src 'self'",
        "manifest-src 'self'",
```

4. `handleHttp` の中、`/api/session` の分岐の直後へ購読 API の分岐を置く。
   405 判定より**前**に置くこと。`DELETE` は現在 405 で弾かれる。

```ts
    if (path.startsWith('/api/push/')) {
      this.handlePushRequest(path, req, res);
      return;
    }
```

5. 次のメソッドを追加する。

```ts
  /**
   * 購読APIを処理する。
   *
   * 購読情報は「その端末へ通知を送れる資格」そのものなので、
   * 認証と Origin 検証を通さずに受け付けてはならない。
   * 保存内容はログ・エラー本文へ出さない。
   */
  private handlePushRequest(path: string, req: IncomingMessage, res: ServerResponse): void {
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
    if (!this.isAuthorized(req)) {
      this.sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const push = this.options.push ?? null;
    if (push === null) {
      this.sendJson(res, 404, { error: 'not-found' });
      return;
    }

    if (path === '/api/push/key' && req.method === 'GET') {
      this.sendJson(res, 200, { publicKey: push.publicKey });
      return;
    }

    if (path === '/api/push/subscribe' && (req.method === 'POST' || req.method === 'DELETE')) {
      const isDelete = req.method === 'DELETE';
      this.readJsonBody(req, res, (parsed) => {
        if (isDelete) {
          const endpoint =
            typeof parsed === 'object' && parsed !== null
              ? (parsed as Record<string, unknown>)['endpoint']
              : undefined;
          if (typeof endpoint !== 'string') {
            this.sendJson(res, 400, { error: 'invalid-request' });
            return;
          }
          push.unsubscribe(endpoint);
          res.writeHead(204);
          res.end();
          return;
        }
        if (!push.subscribe(parsed)) {
          this.sendJson(res, 400, { error: 'invalid-request' });
          return;
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }

    this.sendJson(res, 404, { error: 'not-found' });
  }

  /** 小さなJSON本文を読み取る。上限を超えたら 413。 */
  private readJsonBody(
    req: IncomingMessage,
    res: ServerResponse,
    onBody: (parsed: unknown) => void,
  ): void {
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
      try {
        onBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        this.sendJson(res, 400, { error: 'invalid-request' });
      }
    });
  }

  /** 接続中の認証済み端末数。通知の抑制判定に使う。 */
  get activeClientCount(): number {
    return this.clients.size;
  }
```

- [ ] **Step 5: 成功を確認する**

Run: `npx vitest run tests/integration/push-api.test.ts`
Expected: PASS（7件）

- [ ] **Step 6: 検証してコミットする**

```bash
npm run lint && npm run typecheck && npm test
git add src/notify/push-service.ts src/server/server.ts tests/integration/push-api.test.ts
git commit -m "購読APIを追加し、CSPでService Workerとmanifestを許可"
```

---

### Task 6: 組み立てと抑制

**Files:**
- Modify: `src/cli/main.ts`, `src/cli/banner.ts`

**Interfaces:**
- Consumes: `IdleWatcher`, `SubscriptionStore`, `PushSender`, `loadOrCreateVapidKeys`, `buildIdlePayload`, `createPushService`, `configDir`, `TermWatchServer.activeClientCount`
- Produces: なし（配線のみ）

- [ ] **Step 1: 通知の組み立てを書く**

`src/cli/main.ts` の先頭へ import を加える。

```ts
import { join } from 'node:path';
import { IdleWatcher } from '../notify/idle-watcher.js';
import { configDir } from '../notify/paths.js';
import { buildIdlePayload, loadOrCreateVapidKeys, PushSender } from '../notify/push-sender.js';
import { createPushService, type PushService } from '../notify/push-service.js';
import { SubscriptionStore } from '../notify/subscription-store.js';
```

続けて、`TermWatchServer` の生成より前へ追加する。
`--local-only` のときは通知経路が無いため作らない。

```ts
  // 通知は付随機能。購読が無ければ何も起きず、失敗しても本体を止めない。
  let pushService: PushService | null = null;
  let pushSender: PushSender | null = null;
  if (options.notify && !options.localOnly) {
    try {
      const dir = configDir();
      const store = new SubscriptionStore(join(dir, 'subscriptions.json'));
      const keys = loadOrCreateVapidKeys(join(dir, 'vapid.json'));
      pushSender = new PushSender(keys, store);
      pushService = createPushService(pushSender, store);
    } catch {
      // 鍵を用意できなくても TermWatch は動かす。内容はログへ出さない。
      process.stderr.write('通知機能を初期化できませんでした。通知は無効のまま起動します。\n');
    }
  }
```

`TermWatchServer` の生成へ `push: pushService` を渡す。

- [ ] **Step 2: 検知と抑制を書く**

`localIo.attach()` の後、終了待ちの Promise より前へ追加する。

```ts
  let idleWatcher: IdleWatcher | null = null;
  if (pushSender !== null) {
    const sender = pushSender;
    const idleMs = options.notifyIdleSeconds * 1000;
    const watcher = new IdleWatcher({
      idleMs,
      onIdle: () => {
        // スマートフォンが画面を開いている間は送らない。
        // iOS では画面を閉じると WebSocket が切れるため、これで判定できる。
        if ((server?.activeClientCount ?? 0) > 0) return;
        void sender.send(buildIdlePayload(session.displayCommand, idleMs));
      },
    });
    idleWatcher = watcher;
    session.on('data', () => {
      watcher.noteOutput();
    });
  }
```

`cleanup()` の中へ `idleWatcher?.stop();` を追加する。

- [ ] **Step 3: 起動バナーへ状態を出す**

`src/cli/banner.ts` の `BannerInput` へ追加する。

```ts
  /** 通知までの秒数。無効なら null。 */
  readonly notifyIdleSeconds: number | null;
```

`buildBanner` の中、`記録` の行の直後へ追加する。

```ts
    lines.push(
      input.notifyIdleSeconds === null
        ? '  通知         : 無効'
        : `  通知         : 出力が${input.notifyIdleSeconds}秒止まったら通知（要ホーム画面追加）`,
    );
```

`main.ts` の `buildBanner` 呼び出しへ次を渡す。

```ts
      notifyIdleSeconds: pushService === null ? null : options.notifyIdleSeconds,
```

- [ ] **Step 4: 動作を確認する**

```bash
npm run lint && npm run typecheck && npm test && npm run build
node dist/app/cli/main.js --help
```

Expected: ヘルプに `--notify-idle-seconds` と `--no-notify` が出る

- [ ] **Step 5: コミットする**

```bash
git add src/cli/main.ts src/cli/banner.ts tests/unit
git commit -m "出力停止の検知を組み立て、接続中は通知を抑制する"
```

---

### Task 7: PWA（manifest・Service Worker・アイコン）

**Files:**
- Create: `web/public/manifest.json`, `web/public/sw.js`, `scripts/make-icons.mjs`
- Modify: `web/index.html`, `package.json`

**Interfaces:**
- Consumes: なし
- Produces: `/manifest.json`、`/sw.js`、`/icon-192.png`、`/icon-512.png` が配信される

- [ ] **Step 1: アイコン生成スクリプトを書く**

`scripts/make-icons.mjs`。iOS のホーム画面追加には PNG が要る。
外部依存を増やさないため `node:zlib` で最小の PNG を書き出す。

```js
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 単色の正方形PNGを作る。外部依存を増やさないための最小実装。
const BACKGROUND = [13, 17, 23]; // ターミナル背景色に合わせる

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 2; // トゥルーカラー
  const row = Buffer.concat([
    Buffer.from([0]), // フィルターなし
    Buffer.concat(Array.from({ length: size }, () => Buffer.from(BACKGROUND))),
  ]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');
mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), png(size));
}
console.log('[icons] web/public へ icon-192.png と icon-512.png を生成しました');
```

- [ ] **Step 2: アイコンを生成する**

```bash
node scripts/make-icons.mjs
```

Expected: `web/public/icon-192.png` と `icon-512.png` ができる

- [ ] **Step 3: manifest を書く**

`web/public/manifest.json`:

```json
{
  "name": "TermWatch",
  "short_name": "TermWatch",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#0d1117",
  "theme_color": "#0d1117",
  "icons": [
    { "src": "./icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "./icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 4: Service Worker を書く**

`web/public/sw.js`:

```js
/**
 * TermWatch の Service Worker。
 *
 * 役割は通知の受信と、タップで画面を開くことだけ。
 * オフライン用のキャッシュは持たない（PCが動いていなければ意味がないため）。
 */

self.addEventListener('push', (event) => {
  let payload = { title: 'TermWatch', body: '出力が止まりました' };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // 本文を読めなくても通知自体は出す。
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'TermWatch', {
      body: payload.body ?? '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'termwatch-idle',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    }),
  );
});
```

- [ ] **Step 5: `web/index.html` へ link を追加する**

`<head>` 内、既存の `<title>` の直後へ:

```html
    <link rel="manifest" href="./manifest.json" />
    <link rel="apple-touch-icon" href="./icon-192.png" />
```

- [ ] **Step 6: `package.json` へスクリプトを追加する**

`scripts` へ `"icons": "node scripts/make-icons.mjs"` を加え、
`build` スクリプトの先頭で `npm run icons &&` を呼ぶ。

- [ ] **Step 7: 配信を確認する**

```bash
npm run build
ls dist/web/manifest.json dist/web/sw.js dist/web/icon-192.png
```

Expected: 3ファイルとも存在する（Vite は `web/public` の中身を出力先の直下へ複写する）

`sw.js` が無いと、未知パスは `index.html` へフォールバックするため
HTML が返り、Service Worker の登録が不可解な理由で失敗する。必ず確認すること。

- [ ] **Step 8: コミットする**

```bash
git add web/public scripts/make-icons.mjs web/index.html package.json
git commit -m "PWA の manifest・Service Worker・アイコンを追加"
```

---

### Task 8: 通知の有効化 UI

**Files:**
- Modify: `web/index.html`, `web/src/main.ts`

**Interfaces:**
- Consumes: `/api/push/key`, `/api/push/subscribe`
- Produces: なし

- [ ] **Step 1: ボタンを置く**

`web/index.html` のヘッダー、`control-toggle` ボタンの直後へ:

```html
        <button type="button" id="notify-toggle">通知を有効にする</button>
```

- [ ] **Step 2: 登録処理を書く**

`web/src/main.ts` の末尾へ追加する。
iOS では利用者の操作が起点でないと許可を求められないため、
読み込み時に自動で `requestPermission()` を呼んではならない。

```ts
/* ------------------------------------------------------------------ */
/* 通知                                                                */
/* ------------------------------------------------------------------ */

const notifyToggle = el<HTMLButtonElement>('notify-toggle');

/** base64url の VAPID 公開鍵を Uint8Array へ直す。 */
function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function markNotifyEnabled(): void {
  notifyToggle.textContent = '通知は有効です';
  notifyToggle.disabled = true;
}

async function enableNotifications(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setNotice('この端末では通知を使えません。ホーム画面へ追加してから開いてください。', 'warn');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    setNotice('通知が許可されませんでした。', 'warn');
    return;
  }

  const registration = await navigator.serviceWorker.register('./sw.js');
  const keyResponse = await fetch('/api/push/key', { credentials: 'same-origin' });
  if (!keyResponse.ok) {
    setNotice('通知の設定を取得できませんでした。', 'warn');
    return;
  }
  const { publicKey } = (await keyResponse.json()) as { publicKey: string };

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(publicKey),
  });

  const saved = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!saved.ok) {
    setNotice('通知の登録に失敗しました。', 'warn');
    return;
  }

  markNotifyEnabled();
  setNotice('通知を有効にしました。出力が止まるとお知らせします。');
}

notifyToggle.addEventListener('click', () => {
  void enableNotifications().catch(() => {
    setNotice('通知を有効にできませんでした。', 'warn');
  });
});
```

- [ ] **Step 3: 既に登録済みなら表示を合わせる**

`showApp()` の中へ追加する。

```ts
  // 登録済みなら押せないようにする。
  void navigator.serviceWorker?.getRegistration().then(async (registration) => {
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription != null) markNotifyEnabled();
  });
```

- [ ] **Step 4: 確認する**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Expected: すべて成功

- [ ] **Step 5: コミットする**

```bash
git add web/index.html web/src/main.ts
git commit -m "通知を有効にする操作を追加"
```

---

### Task 9: 手順書と記録

**Files:**
- Modify: `docs/MANUAL_TESTS_WINDOWS.md`, `docs/DECISIONS.md`, `docs/ACCEPTANCE_RESULTS.md`, `README.md`

- [ ] **Step 1: 手動確認 MT-18 を追加する**

`docs/MANUAL_TESTS_WINDOWS.md` の末尾へ:

```markdown
## MT-18: プッシュ通知

Apple への実配信は自動化できないため、ここで確認する。

| 手順 | 期待結果 |
|---|---|
| iPhone で転送 URL を開き、共有メニューから「ホーム画面に追加」 | アイコンが追加される |
| ホーム画面のアイコンから開き、ペアリングする | 通常どおり接続できる |
| 「通知を有効にする」を押す | 許可を求められ、許可すると「通知は有効です」に変わる |
| 画面を閉じて、PC 側で 30 秒以上出力を止める | 通知が届く |
| 通知をタップする | TermWatch が開く |
| 画面を開いたまま 30 秒出力を止める | 通知は**届かない**（見ているため） |
| `--no-notify` で起動する | 「通知を有効にする」を押しても登録できない |

**注意**: Safari のタブのままでは通知を受け取れない（iOS の制約）。
必ずホーム画面へ追加したものから開くこと。
```

- [ ] **Step 2: 判断の記録を追加する**

`docs/DECISIONS.md` の末尾へ D-029 として次を書く。

- iOS で画面を閉じた状態へ届ける手段は Web Push しかないこと
- 通知本文にコマンド名と経過時間しか載せないこと。ターミナル内容は含めない
- 接続中かどうかの判定に WebSocket の接続有無を使うこと。
  iOS では画面を閉じると切れるため、プロトコルを増やさずに済む
- TermWatch にとって初めての永続状態であること。置くのは VAPID 鍵と購読情報だけ
- `web-push` を追加した理由（RFC 8291 の自前実装は暗号の強度を損なう危険がある）
- 要件定義書では対象外としていた機能であり、第18章「将来拡張候補」として実装したこと

- [ ] **Step 3: 受け入れ記録と README を更新する**

`docs/ACCEPTANCE_RESULTS.md` の残作業へ MT-18 を追加する。
`README.md` の「iOS のプッシュ通知は対象外」という記述を実装済みへ書き換え、
ホーム画面への追加が必須であること、`--notify-idle-seconds` と `--no-notify` を追記する。

- [ ] **Step 4: 確認してコミットする**

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run package:win
git add docs README.md
git commit -m "プッシュ通知の手順書と記録を追加"
```

---

## 完了条件

- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`npm run package:win` がすべて成功する
- 通知本文にターミナル内容が含まれないことが単体テストで固定されている
- 未認証の購読要求が拒否されることが統合テストで固定されている
- `dist/web/` に `manifest.json`、`sw.js`、`icon-192.png`、`icon-512.png` がある
- MT-18 が残作業として記録されている
