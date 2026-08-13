import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * プッシュ購読情報の永続化。
 *
 * 購読情報は「その端末へ通知を送れる資格」そのもの。
 * 権限を所有者のみに絞り、ログ・エラー出力へ一切出さない。
 */

/** endpoint と鍵の長さ上限。壊れた入力や肥大化を防ぐ。 */
export const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;
/** 保存する購読の上限。超えた分は古いものから削除する。 */
const MAX_SUBSCRIPTIONS = 10;

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

/**
 * endpoint として受け入れられる値か検証する。
 *
 * 長さ上限と https 限定の制約は、購読の登録（{@link parseSubscription}）と
 * 解除（DELETE リクエスト）の双方で同じ基準を使うためにここへ切り出している。
 */
export function isValidEndpoint(value: unknown): value is string {
  if (!isNonEmptyString(value, MAX_ENDPOINT_LENGTH)) return false;
  try {
    // 平文の宛先は受け付けない。
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** 受け取った購読情報を検証する。信用できない入力として扱う。 */
export function parseSubscription(input: unknown): PushSubscriptionRecord | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;

  const endpoint = record['endpoint'];
  if (!isValidEndpoint(endpoint)) return null;

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
    // 上限を超えたら古いもの（配列の先頭側）から捨てる。
    while (next.length > MAX_SUBSCRIPTIONS) next.shift();
    this.save(next);
  }

  remove(endpoint: string): void {
    this.save(this.list().filter((item) => item.endpoint !== endpoint));
  }

  /**
   * 一時ファイルへ書いてから rename する。
   * 複数プロセス（PC本体とテスト等）が同時に書いても、
   * 読み手は常に「どちらか一方の完全な内容」だけを見る（破損した中間状態を見せない）。
   */
  private save(records: readonly PushSubscriptionRecord[]): void {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(records), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmpPath, this.filePath);
    } catch {
      // 保存できなくても TermWatch 本体は止めない。内容はログへ出さない。
    }
  }
}
