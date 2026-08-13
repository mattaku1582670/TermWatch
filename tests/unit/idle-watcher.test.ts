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
