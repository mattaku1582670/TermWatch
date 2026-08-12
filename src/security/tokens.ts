import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  normalizePairingCode,
} from '../shared/pairing.js';

/**
 * セッショントークンとワンタイムペアリングコードの生成・検証。
 *
 * ペアリングコードの設計（docs/DECISIONS.md D-004）:
 * - 文字集合: Crockford Base32 からさらに 0 と 1 を除いた30文字
 *   （I/L/O/U は Crockford の時点で除外済み。残る紛らわしい 0/O・1/I を排除）
 * - 長さ: 8文字（表示は 4-4 のハイフン区切り。入力時のハイフンは任意）
 * - エントロピー: log2(30^8) ≒ 39.2bit
 * - 有効期限: 起動後10分、または最初の認証成功時の早い方
 * - 総当たり対策: 認証失敗のレート制限（src/security/rate-limit.ts）
 */

// 文字集合・正規化・整形は src/shared/pairing.ts に置く（Web側と共有するため）。
export {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  normalizePairingCode,
} from '../shared/pairing.js';
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** セッショントークンのバイト長（256bit）。 */
export const SESSION_TOKEN_BYTES = 32;

/**
 * 暗号学的乱数によるセッショントークンを生成する。
 * base64url なので Cookie / ヘッダーへそのまま載せられる。
 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * ワンタイムペアリングコードを生成する（正規化済み・区切りなしの8文字）。
 */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

/**
 * 定数時間で文字列を比較する。長さの違いも情報を漏らさないよう固定長へ畳む。
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // 長さが異なると timingSafeEqual が例外を投げるため、同じ長さへ正規化する。
  const length = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(length);
  const padB = Buffer.alloc(length);
  bufA.copy(padA);
  bufB.copy(padB);
  return timingSafeEqual(padA, padB) && bufA.length === bufB.length;
}

/**
 * 1つのTermWatch起動に対応する認証状態。
 *
 * - ペアリングコードは10分または最初の認証成功で失効する。
 * - セッショントークンはプロセス終了時に破棄する。
 */
export class SessionAuth {
  private readonly token: string;
  private pairingCode: string | null;
  private readonly pairingExpiresAt: number;
  private tokenRevoked = false;

  constructor(now: number = Date.now()) {
    this.token = generateSessionToken();
    this.pairingCode = generatePairingCode();
    this.pairingExpiresAt = now + PAIRING_CODE_TTL_MS;
  }

  /** PC側ターミナルへの表示専用。ログ・URL・エラーへ出さないこと。 */
  getPairingCodeForDisplay(): string | null {
    return this.pairingCode === null ? null : formatPairingCode(this.pairingCode);
  }

  isPairingActive(now: number = Date.now()): boolean {
    return this.pairingCode !== null && now < this.pairingExpiresAt;
  }

  get pairingDeadline(): number {
    return this.pairingExpiresAt;
  }

  /**
   * ペアリングコードを検証する。成功した場合だけセッショントークンを返し、
   * 同時にペアリングコードを失効させる（ワンタイム）。
   */
  verifyPairing(input: string, now: number = Date.now()): string | null {
    if (this.pairingCode === null || now >= this.pairingExpiresAt) {
      return null;
    }
    const normalized = normalizePairingCode(input);
    if (!safeCompare(normalized, this.pairingCode)) {
      return null;
    }
    this.pairingCode = null;
    return this.token;
  }

  /** セッショントークンの照合。 */
  verifyToken(candidate: string | null | undefined): boolean {
    if (this.tokenRevoked) return false;
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    return safeCompare(candidate, this.token);
  }

  /** TermWatch終了時に呼び、トークンを無効化する。 */
  revoke(): void {
    this.tokenRevoked = true;
    this.pairingCode = null;
  }
}
