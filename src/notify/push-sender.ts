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

/**
 * VAPID の連絡先。
 *
 * Apple のプッシュ網は到達しない宛先を受け付けない。
 * `mailto:termwatch@localhost` は `403 BadJwtToken` で拒否されることを実測した（D-032）。
 * 個人情報を埋め込まずに済むよう、プロジェクトの URL を使う。
 */
const VAPID_SUBJECT = 'https://github.com/mattaku1582670/TermWatch';

/**
 * 外向き通信に使うプロキシ。
 *
 * `web-push` は環境変数を自動では読まないため、明示的に渡す必要がある。
 * 社内ネットワークなどプロキシ必須の環境では、渡さないと接続が ETIMEDOUT で
 * 失敗し続ける（実測。D-032）。
 *
 * 値には資格情報が含まれることがあるため、ログへ一切出さない。
 */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

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

function readVapidKeys(filePath: string): VapidKeys | null {
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
    // 読めない。呼び出し側で作り直すか判断する。
  }
  return null;
}

/**
 * VAPID 鍵を読み込む。無ければ生成して保存する。
 * 秘密鍵はスマートフォンへ渡さず、ログにも出さない。
 *
 * 複数プロセスが同時に初回起動した場合に備え、書き込みは `wx`（排他生成）で
 * 行う。既に他方が書き終えていれば書き込みは失敗するので、その場合は
 * 自分が生成した鍵を捨てて、先に書き込まれたファイルを読み直す（先勝ち）。
 */
export function loadOrCreateVapidKeys(filePath: string): VapidKeys {
  const existing = readVapidKeys(filePath);
  if (existing !== null) return existing;

  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(filePath, JSON.stringify(keys), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return keys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = readVapidKeys(filePath);
      if (winner !== null) return winner;
    }
    throw error;
  }
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
   *
   * 取り除くのは失効した購読（404/410）だけにする。
   * 403 は「購読が消えた」ではなく、こちら側の VAPID 設定が誤っているときにも返る
   * （`BadJwtToken`。実測。D-032）。403 で消すと、設定ミスのたびに
   * 正常な購読まで失われ、利用者は毎回登録し直すことになる。
   */
  async send(payload: NotificationPayload): Promise<void> {
    const subscriptions = this.store.list();
    if (subscriptions.length === 0) return;

    const body = JSON.stringify(payload);
    const proxy = proxyFromEnv();
    await Promise.all(
      subscriptions.map(async (subscription: PushSubscriptionRecord) => {
        try {
          await webpush.sendNotification(subscription, body, proxy === undefined ? {} : { proxy });
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.store.remove(subscription.endpoint);
          }
          // 送信失敗の詳細は出さない。購読情報とプロキシの資格情報が混ざるため。
        }
      }),
    );
  }
}
