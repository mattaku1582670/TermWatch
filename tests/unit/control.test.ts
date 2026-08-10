import { describe, expect, it } from 'vitest';
import { ControlManager } from '../../src/server/control.js';
import {
  CONTROL_DISCONNECT_GRACE_MS,
  CONTROL_WARNING_MS,
} from '../../src/shared/protocol.js';

const TEN_MINUTES = 10 * 60_000;

describe('ControlManager', () => {
  it('操作権を取得できる', () => {
    const manager = new ControlManager(TEN_MINUTES);
    const result = manager.request(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(manager.isHeld()).toBe(true);
    expect(manager.isHolder(result.grant.handle, 0)).toBe(true);
    expect(result.grant.expiresAt).toBe(TEN_MINUTES);
  });

  it('期限を過ぎたハンドルは tick を待たずに保持者と認められない', () => {
    const manager = new ControlManager(TEN_MINUTES);
    const result = manager.request(0);
    if (!result.ok) throw new Error('取得できるはず');
    expect(manager.isHolder(result.grant.handle, TEN_MINUTES - 1)).toBe(true);
    // 定期tickが走る前でも、期限到達後の入力は拒否される。
    expect(manager.isHolder(result.grant.handle, TEN_MINUTES)).toBe(false);
  });

  it('同時に保持できるのは1台だけ', () => {
    const manager = new ControlManager(TEN_MINUTES);
    const first = manager.request(0);
    const second = manager.request(0);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('busy');
  });

  it('他人のハンドルでは保持者と判定されない', () => {
    const manager = new ControlManager(TEN_MINUTES);
    manager.request(0);
    expect(manager.isHolder('偽のハンドル')).toBe(false);
    expect(manager.isHolder(null)).toBe(false);
  });

  it('解除後は別の端末が取得できる', () => {
    const manager = new ControlManager(TEN_MINUTES);
    const first = manager.request(0);
    if (!first.ok) throw new Error('取得できるはず');
    manager.release(first.grant.handle);
    expect(manager.isHeld()).toBe(false);
    expect(manager.request(0).ok).toBe(true);
  });

  it('他人のハンドルでは解除できない', () => {
    const manager = new ControlManager(TEN_MINUTES);
    manager.request(0);
    expect(manager.release('偽のハンドル')).toBeNull();
    expect(manager.isHeld()).toBe(true);
  });

  it('残り1分で1度だけ警告する', () => {
    const manager = new ControlManager(TEN_MINUTES);
    manager.request(0);
    expect(manager.tick(TEN_MINUTES - CONTROL_WARNING_MS - 1)).toEqual([]);
    const events = manager.tick(TEN_MINUTES - CONTROL_WARNING_MS);
    expect(events[0]?.kind).toBe('warning');
    // 2回目は警告しない。
    expect(manager.tick(TEN_MINUTES - CONTROL_WARNING_MS + 1)).toEqual([]);
  });

  it('期限到達で自動解除する', () => {
    const manager = new ControlManager(TEN_MINUTES);
    manager.request(0);
    const events = manager.tick(TEN_MINUTES);
    expect(events[0]).toMatchObject({ kind: 'revoked', reason: 'expired' });
    expect(manager.isHeld()).toBe(false);
  });

  it('60秒以上の切断で操作権を解除する', () => {
    const manager = new ControlManager(TEN_MINUTES);
    const result = manager.request(0);
    if (!result.ok) throw new Error('取得できるはず');
    manager.detach(result.grant.handle, 1000);

    expect(manager.tick(1000 + CONTROL_DISCONNECT_GRACE_MS - 1)).toEqual([]);
    const events = manager.tick(1000 + CONTROL_DISCONNECT_GRACE_MS);
    expect(events[0]).toMatchObject({ kind: 'revoked', reason: 'disconnected' });
    expect(manager.isHeld()).toBe(false);
  });

  it('60秒以内の再接続では操作権を維持する', () => {
    const manager = new ControlManager(TEN_MINUTES);
    const result = manager.request(0);
    if (!result.ok) throw new Error('取得できるはず');
    manager.detach(result.grant.handle, 1000);
    const grant = manager.attach(result.grant.handle, 30_000);
    expect(grant).not.toBeNull();
    expect(manager.tick(1000 + CONTROL_DISCONNECT_GRACE_MS)).toEqual([]);
    expect(manager.isHeld()).toBe(true);
  });

  it('期限切れ後の attach は失敗する', () => {
    const manager = new ControlManager(TEN_MINUTES);
    const result = manager.request(0);
    if (!result.ok) throw new Error('取得できるはず');
    expect(manager.attach(result.grant.handle, TEN_MINUTES + 1)).toBeNull();
    expect(manager.attach('別のハンドル', 0)).toBeNull();
    expect(manager.attach(null, 0)).toBeNull();
  });

  it('子プロセス終了後は取得できない', () => {
    const manager = new ControlManager(TEN_MINUTES);
    const result = manager.request(0);
    if (!result.ok) throw new Error('取得できるはず');
    const event = manager.markProcessExited();
    expect(event).toMatchObject({ kind: 'revoked', reason: 'process-exited' });
    const retry = manager.request(0);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe('process-exited');
  });

  it('有効時間が不正なら例外', () => {
    expect(() => new ControlManager(0)).toThrow();
    expect(() => new ControlManager(-1)).toThrow();
  });
});
