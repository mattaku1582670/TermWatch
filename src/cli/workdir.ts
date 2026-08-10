import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 作業フォルダーの検証。
 *
 * 空白や日本語を含むWindowsパスをそのまま扱えるよう、
 * 引用符の除去や結合は行わず resolve だけを使う。
 */

export type WorkdirResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

export function resolveWorkdir(input: string | null, base: string = process.cwd()): WorkdirResult {
  if (input === null) {
    return { ok: true, path: base };
  }
  if (input.trim().length === 0) {
    return { ok: false, message: '--cwd に空のパスは指定できません。' };
  }

  const target = resolve(base, input);
  try {
    const stat = statSync(target);
    if (!stat.isDirectory()) {
      return { ok: false, message: `--cwd がフォルダーではありません: ${target}` };
    }
  } catch {
    return { ok: false, message: `--cwd のフォルダーが見つかりません: ${target}` };
  }
  return { ok: true, path: target };
}
