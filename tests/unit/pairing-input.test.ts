import { describe, expect, it } from 'vitest';
import {
  caretIndexAfter,
  formatPairingInput,
  normalizePairingCode,
} from '../../src/shared/pairing.js';

/**
 * ペアリングコード入力欄の整形。
 *
 * ハイフンは照合時に無視されるため入力不要だが、PC側の表示が `ABCD-EFGH` なので
 * 見比べながら打てるよう自動で挿入する。
 */
describe('formatPairingInput', () => {
  it('4文字目まではそのまま', () => {
    expect(formatPairingInput('A')).toBe('A');
    expect(formatPairingInput('ABC')).toBe('ABC');
  });

  it('4文字そろったら区切りを付ける', () => {
    expect(formatPairingInput('ABCD')).toBe('ABCD-');
    expect(formatPairingInput('ABCDE')).toBe('ABCD-E');
    expect(formatPairingInput('ABCD2345')).toBe('ABCD-2345');
  });

  it('小文字を大文字へ直す', () => {
    expect(formatPairingInput('abcd2345')).toBe('ABCD-2345');
  });

  it('利用者が打ったハイフンや空白を吸収する', () => {
    expect(formatPairingInput('ABCD-2345')).toBe('ABCD-2345');
    expect(formatPairingInput('AB CD 23 45')).toBe('ABCD-2345');
    expect(formatPairingInput('　ABCD　2345　')).toBe('ABCD-2345');
  });

  it('文字集合外の文字を捨てる', () => {
    // 0/1/I/L/O/U は紛らわしいため文字集合に無い。
    expect(formatPairingInput('AB0C1D')).toBe('ABCD-');
    expect(formatPairingInput('あABCD')).toBe('ABCD-');
  });

  it('8文字を超える分は捨てる', () => {
    expect(formatPairingInput('ABCD2345XYZ')).toBe('ABCD-2345');
  });

  it('空文字はそのまま', () => {
    expect(formatPairingInput('')).toBe('');
  });
});

describe('caretIndexAfter', () => {
  it('区切りを跨いで数える', () => {
    expect(caretIndexAfter('ABCD-2345', 0)).toBe(0);
    expect(caretIndexAfter('ABCD-2345', 4)).toBe(4);
    expect(caretIndexAfter('ABCD-2345', 5)).toBe(6);
    expect(caretIndexAfter('ABCD-2345', 8)).toBe(9);
  });

  it('数が範囲を超えたら末尾を返す', () => {
    expect(caretIndexAfter('ABCD-', 99)).toBe(5);
  });
});

describe('照合との整合', () => {
  it('整形後の文字列は元のコードへ正規化される', () => {
    const code = 'ABCD2345';
    expect(normalizePairingCode(formatPairingInput('abcd 2345'))).toBe(code);
    expect(normalizePairingCode(formatPairingInput('ABCD-2345'))).toBe(code);
  });
});
