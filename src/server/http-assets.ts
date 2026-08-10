import { readFileSync, statSync } from 'node:fs';
import { normalize, join, sep, extname } from 'node:path';

/**
 * Web UI の静的ファイル配信。
 *
 * - 配信対象は指定ルート配下に限定し、パストラバーサルを拒否する。
 * - HTMLへ動的な文字列を差し込まない（未エスケープHTML挿入の防止）。
 */

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
});

export interface Asset {
  readonly body: Buffer;
  readonly contentType: string;
}

/**
 * URLパスを安全なファイルパスへ解決する。ルート外なら null。
 */
export function resolveAssetPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relative = decoded.replace(/^\/+/, '');
  const target = normalize(join(root, relative === '' ? 'index.html' : relative));

  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    return null;
  }
  return target;
}

/**
 * 静的ファイルを読み込む。存在しない場合は null。
 */
export function readAsset(root: string, urlPath: string): Asset | null {
  const target = resolveAssetPath(root, urlPath);
  if (target === null) return null;
  try {
    if (!statSync(target).isFile()) return null;
    const body = readFileSync(target);
    const contentType = MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
    return { body, contentType };
  } catch {
    return null;
  }
}
