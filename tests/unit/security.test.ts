import { describe, expect, it } from 'vitest';
import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  SessionAuth,
  formatPairingCode,
  generatePairingCode,
  generateSessionToken,
  normalizePairingCode,
  safeCompare,
} from '../../src/security/tokens.js';
import { checkSameOrigin, isLoopbackHost } from '../../src/security/origin.js';
import { FailureRateLimiter } from '../../src/security/rate-limit.js';

describe('トークン生成', () => {
  it('セッショントークンは256bit相当で毎回異なる', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url').length).toBe(32);
  });

  it('ペアリングコードは指定文字集合の8文字', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generatePairingCode();
      expect(code.length).toBe(PAIRING_CODE_LENGTH);
      for (const ch of code) {
        expect(PAIRING_ALPHABET).toContain(ch);
      }
    }
  });

  it('紛らわしい文字を含まない', () => {
    for (const ch of ['0', '1', 'I', 'L', 'O', 'U']) {
      expect(PAIRING_ALPHABET).not.toContain(ch);
    }
  });

  it('表示は 4-4 のハイフン区切り', () => {
    expect(formatPairingCode('ABCD2345')).toBe('ABCD-2345');
  });

  it('入力を正規化する', () => {
    expect(normalizePairingCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizePairingCode(' ab cd 23 45 ')).toBe('ABCD2345');
  });
});

describe('safeCompare', () => {
  it('一致・不一致を正しく判定する', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abd')).toBe(false);
    expect(safeCompare('abc', 'abcd')).toBe(false);
    expect(safeCompare('', '')).toBe(true);
    expect(safeCompare('', 'a')).toBe(false);
  });
});

describe('SessionAuth', () => {
  it('正しいコードでトークンを発行し、コードはワンタイムで失効する', () => {
    const auth = new SessionAuth();
    const display = auth.getPairingCodeForDisplay();
    expect(display).not.toBeNull();
    const code = display as string;

    const token = auth.verifyPairing(code);
    expect(token).not.toBeNull();
    expect(auth.verifyToken(token)).toBe(true);

    // 2回目は失敗する。
    expect(auth.verifyPairing(code)).toBeNull();
    expect(auth.getPairingCodeForDisplay()).toBeNull();
  });

  it('小文字・区切りなしの入力も受け付ける', () => {
    const auth = new SessionAuth();
    const code = (auth.getPairingCodeForDisplay() as string).replace('-', '').toLowerCase();
    expect(auth.verifyPairing(code)).not.toBeNull();
  });

  it('誤ったコードを拒否する', () => {
    const auth = new SessionAuth();
    expect(auth.verifyPairing('ZZZZ-ZZZZ')).toBeNull();
    // 失敗してもコードは有効なまま。
    expect(auth.isPairingActive()).toBe(true);
  });

  it('10分経過でペアリングコードが失効する', () => {
    const start = Date.now();
    const auth = new SessionAuth(start);
    const code = auth.getPairingCodeForDisplay() as string;
    expect(auth.isPairingActive(start + PAIRING_CODE_TTL_MS - 1)).toBe(true);
    expect(auth.isPairingActive(start + PAIRING_CODE_TTL_MS)).toBe(false);
    expect(auth.verifyPairing(code, start + PAIRING_CODE_TTL_MS)).toBeNull();
  });

  it('無効なトークンでは認証されない', () => {
    const auth = new SessionAuth();
    expect(auth.verifyToken('')).toBe(false);
    expect(auth.verifyToken(null)).toBe(false);
    expect(auth.verifyToken(undefined)).toBe(false);
    expect(auth.verifyToken(generateSessionToken())).toBe(false);
  });

  it('revoke 後はトークンが無効になる', () => {
    const auth = new SessionAuth();
    const token = auth.verifyPairing(auth.getPairingCodeForDisplay() as string) as string;
    expect(auth.verifyToken(token)).toBe(true);
    auth.revoke();
    expect(auth.verifyToken(token)).toBe(false);
  });
});

describe('Origin検証', () => {
  it('同一オリジンを許可する', () => {
    expect(checkSameOrigin('127.0.0.1:43821', 'http://127.0.0.1:43821').ok).toBe(true);
    expect(
      checkSameOrigin('abc-43821.jp.devtunnels.ms', 'https://abc-43821.jp.devtunnels.ms').ok,
    ).toBe(true);
  });

  it('localhost と 127.0.0.1 の表記ゆれを同一ポートに限り許可する', () => {
    expect(checkSameOrigin('127.0.0.1:43821', 'http://localhost:43821').ok).toBe(true);
    expect(checkSameOrigin('127.0.0.1:43821', 'http://localhost:1234').ok).toBe(false);
  });

  it('X-Forwarded-Host を同一オリジン候補として扱う', () => {
    expect(
      checkSameOrigin(
        'localhost:43821',
        'https://abc-43821.jp.devtunnels.ms',
        'abc-43821.jp.devtunnels.ms',
      ).ok,
    ).toBe(true);
  });

  it('別オリジンを拒否する', () => {
    expect(checkSameOrigin('127.0.0.1:43821', 'https://evil.example.com').ok).toBe(false);
    expect(checkSameOrigin('127.0.0.1:43821', 'http://127.0.0.1:1234').ok).toBe(false);
  });

  it('Origin が無い・null・不正な場合を拒否する', () => {
    expect(checkSameOrigin('127.0.0.1:43821', undefined).ok).toBe(false);
    expect(checkSameOrigin('127.0.0.1:43821', 'null').ok).toBe(false);
    expect(checkSameOrigin('127.0.0.1:43821', 'not-a-url').ok).toBe(false);
    expect(checkSameOrigin('127.0.0.1:43821', 'file:///etc/passwd').ok).toBe(false);
    expect(checkSameOrigin(undefined, 'http://127.0.0.1:43821').ok).toBe(false);
  });

  it('isLoopbackHost がループバックを判定する', () => {
    expect(isLoopbackHost('localhost:1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]:80')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('FailureRateLimiter', () => {
  it('規定回数の失敗でロックアウトする', () => {
    const limiter = new FailureRateLimiter({
      maxFailures: 3,
      baseLockoutMs: 1000,
      maxLockoutMs: 10_000,
    });
    const t = 0;
    expect(limiter.recordFailure(t)).toBe(false);
    expect(limiter.recordFailure(t)).toBe(false);
    expect(limiter.recordFailure(t)).toBe(true);
    expect(limiter.isLocked(t)).toBe(true);
    expect(limiter.isLocked(t + 1000)).toBe(false);
  });

  it('ロックアウト時間が倍化し、上限で頭打ちになる', () => {
    const limiter = new FailureRateLimiter({
      maxFailures: 1,
      baseLockoutMs: 1000,
      maxLockoutMs: 3000,
    });
    limiter.recordFailure(0);
    expect(limiter.retryAfterMs(0)).toBe(1000);
    limiter.recordFailure(10_000);
    expect(limiter.retryAfterMs(10_000)).toBe(2000);
    limiter.recordFailure(20_000);
    expect(limiter.retryAfterMs(20_000)).toBe(3000);
    limiter.recordFailure(30_000);
    expect(limiter.retryAfterMs(30_000)).toBe(3000);
  });

  it('成功で失敗カウントをリセットする', () => {
    const limiter = new FailureRateLimiter({
      maxFailures: 2,
      baseLockoutMs: 1000,
      maxLockoutMs: 5000,
    });
    limiter.recordFailure(0);
    limiter.recordSuccess();
    expect(limiter.recordFailure(0)).toBe(false);
  });
});
