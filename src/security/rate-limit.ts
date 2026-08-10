/**
 * 認証失敗に対するレート制限。
 *
 * ローカル待ち受け＋VS Code Private Port Forwarding という構成上、
 * 到達元IPは常に 127.0.0.1 になりうる。そのため「IP単位」ではなく
 * 「サーバー全体（1セッション）」の失敗回数を数える設計とし、
 * ペアリングコードの総当たりをプロセス全体として遅くする。
 */

export interface RateLimitOptions {
  /** ロックアウトまでに許容する連続失敗回数。 */
  readonly maxFailures: number;
  /** 基本ロックアウト時間（ミリ秒）。超過するたびに倍化する。 */
  readonly baseLockoutMs: number;
  /** ロックアウト時間の上限（ミリ秒）。 */
  readonly maxLockoutMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  maxFailures: 5,
  baseLockoutMs: 30_000,
  maxLockoutMs: 15 * 60_000,
};

export class FailureRateLimiter {
  private failures = 0;
  private lockoutLevel = 0;
  private lockedUntil = 0;

  constructor(private readonly options: RateLimitOptions = DEFAULT_RATE_LIMIT) {}

  /** 現在ロックアウト中か。 */
  isLocked(now: number = Date.now()): boolean {
    return now < this.lockedUntil;
  }

  /** ロックアウト解除までの残りミリ秒（解除済みなら0）。 */
  retryAfterMs(now: number = Date.now()): number {
    return Math.max(0, this.lockedUntil - now);
  }

  /** 認証失敗を記録する。ロックアウトへ入った場合はtrueを返す。 */
  recordFailure(now: number = Date.now()): boolean {
    this.failures += 1;
    if (this.failures >= this.options.maxFailures) {
      this.failures = 0;
      const lockout = Math.min(
        this.options.maxLockoutMs,
        this.options.baseLockoutMs * 2 ** this.lockoutLevel,
      );
      this.lockoutLevel += 1;
      this.lockedUntil = now + lockout;
      return true;
    }
    return false;
  }

  /** 認証成功時に失敗回数をリセットする（ロックアウト段階は下げない）。 */
  recordSuccess(): void {
    this.failures = 0;
  }
}
