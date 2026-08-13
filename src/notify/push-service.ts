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
