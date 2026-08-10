import { randomBytes } from 'node:crypto';
import {
  CONTROL_DISCONNECT_GRACE_MS,
  CONTROL_WARNING_MS,
  type ControlReason,
} from '../shared/protocol.js';

/**
 * リモート操作権（操作モード）の管理。
 *
 * 規則:
 * - 同時に操作権を持てるリモートクライアントは1台だけ。
 * - 既定10分（--control-minutes）で自動失効。
 * - 残り1分で警告。
 * - 切断が60秒以上続いたら自動解除。
 * - PC側の入力はこの仕組みの対象外で、常に有効。
 *
 * 操作権はサーバー生成の秘密ハンドルで識別する。
 * ハンドルを持つクライアントだけが再接続時に操作権を引き継げるため、
 * クライアントが自称するIDによる乗っ取りを防げる。
 */

export interface ControlGrant {
  readonly handle: string;
  readonly expiresAt: number;
}

export type ControlEvent =
  | { readonly kind: 'warning'; readonly handle: string; readonly remainingMs: number }
  | { readonly kind: 'revoked'; readonly handle: string; readonly reason: ControlReason };

interface ControlState {
  handle: string;
  expiresAt: number;
  warned: boolean;
  /** 切断された時刻。接続中は null。 */
  disconnectedAt: number | null;
}

export type RequestResult =
  | { readonly ok: true; readonly grant: ControlGrant }
  | { readonly ok: false; readonly reason: 'busy' | 'process-exited' };

export class ControlManager {
  private state: ControlState | null = null;
  private processAlive = true;

  constructor(private readonly durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error('操作権の有効時間には正の値を指定してください。');
    }
  }

  /** 現在操作権が保持されているか。 */
  isHeld(): boolean {
    return this.state !== null;
  }

  /**
   * 指定ハンドルが現在の操作権保持者か。
   *
   * 期限切れも同時に判定する。定期tickの間隔（1秒）内に届いた入力が
   * 期限切れ後に受理されることを防ぐため、入力のたびにこの検査を通すこと。
   */
  isHolder(handle: string | null | undefined, now: number = Date.now()): boolean {
    if (typeof handle !== 'string' || this.state === null) return false;
    if (this.state.handle !== handle) return false;
    return now < this.state.expiresAt;
  }

  get expiresAt(): number | null {
    return this.state?.expiresAt ?? null;
  }

  /** 子プロセス終了を通知する。以後の取得を拒否し、保持中の操作権を解除する。 */
  markProcessExited(): ControlEvent | null {
    this.processAlive = false;
    return this.revoke('process-exited');
  }

  /** 操作権を要求する。 */
  request(now: number = Date.now()): RequestResult {
    if (!this.processAlive) {
      return { ok: false, reason: 'process-exited' };
    }
    if (this.state !== null) {
      return { ok: false, reason: 'busy' };
    }
    const handle = randomBytes(24).toString('base64url');
    this.state = {
      handle,
      expiresAt: now + this.durationMs,
      warned: false,
      disconnectedAt: null,
    };
    return { ok: true, grant: { handle, expiresAt: this.state.expiresAt } };
  }

  /**
   * 再接続時にハンドルで操作権へ復帰する。
   * 有効なら現在の付与情報を返し、無効なら null。
   */
  attach(handle: string | null, now: number = Date.now()): ControlGrant | null {
    if (handle === null || this.state === null || this.state.handle !== handle) {
      return null;
    }
    if (now >= this.state.expiresAt) {
      return null;
    }
    this.state.disconnectedAt = null;
    return { handle: this.state.handle, expiresAt: this.state.expiresAt };
  }

  /** 切断を記録する。60秒以内に再接続すれば操作権を維持する。 */
  detach(handle: string | null, now: number = Date.now()): void {
    if (this.state !== null && handle !== null && this.state.handle === handle) {
      this.state.disconnectedAt = now;
    }
  }

  /** 明示的な解除。保持者本人のみ許可する。 */
  release(handle: string | null): ControlEvent | null {
    if (this.state === null || handle === null || this.state.handle !== handle) {
      return null;
    }
    return this.revoke('released');
  }

  private revoke(reason: ControlReason): ControlEvent | null {
    if (this.state === null) return null;
    const handle = this.state.handle;
    this.state = null;
    return { kind: 'revoked', handle, reason };
  }

  /**
   * 期限・警告・切断猶予を評価する。定期的に呼ぶこと。
   */
  tick(now: number = Date.now()): ControlEvent[] {
    const events: ControlEvent[] = [];
    const state = this.state;
    if (state === null) return events;

    if (now >= state.expiresAt) {
      const revoked = this.revoke('expired');
      if (revoked) events.push(revoked);
      return events;
    }

    if (
      state.disconnectedAt !== null &&
      now - state.disconnectedAt >= CONTROL_DISCONNECT_GRACE_MS
    ) {
      const revoked = this.revoke('disconnected');
      if (revoked) events.push(revoked);
      return events;
    }

    const remaining = state.expiresAt - now;
    if (!state.warned && remaining <= CONTROL_WARNING_MS) {
      state.warned = true;
      events.push({ kind: 'warning', handle: state.handle, remainingMs: remaining });
    }

    return events;
  }

  /** 終了処理。保持中の操作権を破棄する。 */
  dispose(): void {
    this.state = null;
  }
}
