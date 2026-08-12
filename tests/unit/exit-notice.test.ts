import { describe, expect, it } from 'vitest';
import { buildExitNotice } from '../../src/cli/banner.js';

/**
 * 受け入れ基準 13 は、終了コードをPC側とスマートフォン側の両方へ
 * 表示することを求めている。PC側の表示は MT-15（子プロセス強制終了）で
 * 欠落が判明したため、ここで文言を固定する。
 */
describe('buildExitNotice', () => {
  it('終了コードを表示する', () => {
    expect(buildExitNotice('codex', { exitCode: 0, signal: null })).toBe(
      'TermWatch: codex が終了しました（終了コード 0）',
    );
  });

  it('正常終了でも省略しない', () => {
    expect(buildExitNotice('codex', { exitCode: 0, signal: 0 })).toContain('終了コード 0');
  });

  it('強制終了の終了コードを表示する', () => {
    expect(buildExitNotice('codex resume --last', { exitCode: 1, signal: null })).toBe(
      'TermWatch: codex resume --last が終了しました（終了コード 1）',
    );
  });

  it('シグナルがあれば併記する', () => {
    expect(buildExitNotice('codex', { exitCode: 137, signal: 9 })).toBe(
      'TermWatch: codex が終了しました（終了コード 137、シグナル 9）',
    );
  });
});
