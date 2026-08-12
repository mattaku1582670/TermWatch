/**
 * ペアリングコードの文字集合と整形。
 *
 * このモジュールは Node 固有の API を使わない。
 * スマートフォン側の入力欄でも同じ正規化・整形を使うため、
 * Web バンドルから読み込めるようにしておく必要がある
 * （`src/security/tokens.ts` は `node:crypto` を使うので読み込めない）。
 *
 * 設計の根拠は docs/DECISIONS.md D-004。
 */

/**
 * Crockford Base32 からさらに 0 と 1 を除いた30文字。
 * I/L/O/U は Crockford の時点で除外済みで、残る紛らわしい 0/O・1/I を排除している。
 */
export const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;
/** 表示上の区切り位置。 */
const GROUP_SIZE = 4;
const SEPARATOR = '-';

/**
 * 利用者入力を正規化する。小文字・ハイフン・空白・全角空白を吸収する。
 * 文字集合に含まれない文字は取り除く。
 */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .split('')
    .filter((ch) => PAIRING_ALPHABET.includes(ch))
    .join('');
}

/** 表示用に 4-4 のハイフン区切りへ整形する。 */
export function formatPairingCode(code: string): string {
  const normalized = normalizePairingCode(code);
  if (normalized.length !== PAIRING_CODE_LENGTH) return normalized;
  return `${normalized.slice(0, GROUP_SIZE)}${SEPARATOR}${normalized.slice(GROUP_SIZE)}`;
}

/**
 * 入力途中の文字列を整形する。
 *
 * ハイフンは照合時に無視されるため入力しなくてよいが、
 * PC側の表示が `ABCD-EFGH` なので、見比べながら打てるように
 * 4文字目まで入れた時点で自動的に区切りを挿入する。
 * 併せて小文字を大文字へ直し、文字集合外の文字と超過分を捨てる。
 */
export function formatPairingInput(raw: string): string {
  const normalized = normalizePairingCode(raw).slice(0, PAIRING_CODE_LENGTH);
  if (normalized.length < GROUP_SIZE) return normalized;
  return `${normalized.slice(0, GROUP_SIZE)}${SEPARATOR}${normalized.slice(GROUP_SIZE)}`;
}

/**
 * 整形後の文字列で、コード文字を `count` 個ぶん進んだ位置を返す。
 * 入力途中に文字を足したときへカーソルを戻すために使う。
 */
export function caretIndexAfter(formatted: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (formatted[i] !== SEPARATOR) seen += 1;
    if (seen === count) return i + 1;
  }
  return formatted.length;
}
