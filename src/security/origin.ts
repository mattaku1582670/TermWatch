/**
 * Origin検証。
 *
 * 方針: HTTPリクエストの Host ヘッダーと、Origin ヘッダーのホスト部が
 * 完全一致する場合だけ許可する（同一オリジン）。
 *
 * VS Code の Private Port Forwarding 経由では Host も Origin も
 * `<id>-43821.<region>.devtunnels.ms` のようなトンネルのホスト名になるため、
 * この規則だけで「localhost」と「VS Codeの非公開転送ページ」の双方を許可し、
 * それ以外のクロスサイト接続を拒否できる。許可リストを広げる必要はない。
 *
 * Origin ヘッダーが無い接続（curl、非ブラウザクライアント、
 * クロスオリジンのWebSocket偽装）は安全側に倒して拒否する。
 */

export type OriginCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function hostOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/** ループバックを指すホスト名か（ポート付きも可）。 */
export function isLoopbackHost(host: string): boolean {
  const withoutPort = host.startsWith('[')
    ? (host.split(']')[0] ?? '').slice(1)
    : (host.split(':')[0] ?? '');
  const name = withoutPort.toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/**
 * ループバックホストを `127.0.0.1:<port>` へ正規化する。
 * ループバックでなければ null。
 */
export function normalizeLoopback(host: string): string | null {
  if (!isLoopbackHost(host)) return null;
  const port = host.startsWith('[')
    ? (host.split(']:')[1] ?? '')
    : (host.split(':')[1] ?? '');
  return `127.0.0.1:${port}`;
}

/**
 * Host と Origin の同一オリジン性を検証する。
 */
export function checkSameOrigin(
  hostHeader: string | undefined,
  originHeader: string | undefined,
  forwardedHostHeader?: string | undefined,
): OriginCheckResult {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) {
    return { ok: false, reason: 'Hostヘッダーがありません。' };
  }
  if (typeof originHeader !== 'string' || originHeader.length === 0) {
    return { ok: false, reason: 'Originヘッダーがありません。' };
  }
  if (originHeader === 'null') {
    return { ok: false, reason: 'Originがnullです。' };
  }

  const originHost = hostOf(originHeader);
  if (originHost === null) {
    return { ok: false, reason: 'Originを解釈できません。' };
  }

  const host = hostHeader.toLowerCase();
  const candidates = new Set<string>([host]);

  // リバースプロキシ（VS Code Port Forwarding）が Host を書き換える場合に備え、
  // X-Forwarded-Host も同一オリジン候補として扱う。ただし信頼するのは
  // 「Host がループバック」＝ プロキシ経由で届いた場合に限る。
  // 直接アクセスされたリクエストで転送ヘッダーを自称されても採用しない。
  if (isLoopbackHost(host) && typeof forwardedHostHeader === 'string' && forwardedHostHeader.length > 0) {
    // カンマ区切りで複数付く場合は最初の値を使う。
    const first = (forwardedHostHeader.split(',')[0] ?? '').trim().toLowerCase();
    if (first.length > 0) candidates.add(first);
  }

  if (candidates.has(originHost)) {
    return { ok: true };
  }

  // ループバックの表記ゆれ（localhost / 127.0.0.1 / [::1]）はポートが一致する場合のみ許容する。
  const normalizedOrigin = normalizeLoopback(originHost);
  if (
    normalizedOrigin !== null &&
    [...candidates].some((c) => normalizeLoopback(c) === normalizedOrigin)
  ) {
    return { ok: true };
  }

  return { ok: false, reason: 'OriginとHostが一致しません。' };
}
