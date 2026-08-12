import { describe, expect, it } from 'vitest';
import {
  RECONNECT_WARN_MS,
  buildConnectionClass,
  buildConnectionLabel,
} from '../../web/src/connection-label.js';

/**
 * 再接続は無期限に続ける設計のため（MT-15 で確認）、
 * 「再接続中」のままでは瞬断と長期切断を区別できない。
 * 経過時間の併記と、一定時間経過後の警告色を固定する。
 */
describe('buildConnectionLabel', () => {
  const t0 = 1_000_000;

  it('接続中は経過時間を出さない', () => {
    expect(buildConnectionLabel('open', null, t0)).toBe('接続済み');
    expect(buildConnectionLabel('connecting', null, t0)).toBe('接続中…');
  });

  it('再接続中は経過時間を併記する', () => {
    expect(buildConnectionLabel('reconnecting', t0, t0 + 20_000)).toBe('再接続中（20秒）');
    expect(buildConnectionLabel('reconnecting', t0, t0 + 80_000)).toBe('再接続中（1分20秒）');
  });

  it('起点が無ければ従来どおりの表示にする', () => {
    expect(buildConnectionLabel('reconnecting', null, t0)).toBe('再接続中');
  });

  it('子プロセス終了時の表示は変えない', () => {
    expect(buildConnectionLabel('closed', null, t0)).toBe('PC未接続');
    expect(buildConnectionLabel('unauthorized', null, t0)).toBe('認証切れ');
  });
});

describe('buildConnectionClass', () => {
  const t0 = 1_000_000;

  it('接続中は正常色', () => {
    expect(buildConnectionClass('open', null, t0)).toBe('meta ok');
  });

  it('短時間の再接続は警告色にとどめる', () => {
    expect(buildConnectionClass('reconnecting', t0, t0 + RECONNECT_WARN_MS - 1)).toBe('meta warn');
  });

  it('一定時間を超えたら危険色にする', () => {
    expect(buildConnectionClass('reconnecting', t0, t0 + RECONNECT_WARN_MS)).toBe('meta danger');
  });
});
