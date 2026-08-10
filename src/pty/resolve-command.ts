import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, extname } from 'node:path';

/**
 * 実行コマンドの解決。
 *
 * Windowsでは `codex` や `claude` の実体が `.cmd` シム（npmのbinシム）である
 * ことが多い。CreateProcess はバッチファイルを直接実行できないため、
 * PATH と PATHEXT を自前で探索し、バッチであれば cmd.exe 経由で起動する。
 *
 * いずれの場合も引数はargv配列のまま渡し、コマンド文字列を結合しない。
 */

export interface ResolvedCommand {
  /** PTYへ渡す実行ファイル。 */
  readonly file: string;
  /** PTYへ渡す引数配列。 */
  readonly args: readonly string[];
  /** 解決された実体のパス（表示・診断用）。 */
  readonly resolvedPath: string;
  /** cmd.exe を経由するか。 */
  readonly viaCmd: boolean;
}

export type ResolveResult =
  | { readonly ok: true; readonly command: ResolvedCommand }
  | { readonly ok: false; readonly message: string };

const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

function searchDirectories(env: NodeJS.ProcessEnv): string[] {
  const raw = env['PATH'] ?? env['Path'] ?? '';
  return raw
    .split(delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0);
}

/**
 * コマンド名を実体パスへ解決する。見つからなければ null。
 */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const hasExtension = extname(command).length > 0;
  const extensions = platform === 'win32' ? pathExtensions(env) : [];

  const candidatesFor = (base: string): string[] => {
    if (platform !== 'win32') return [base];
    if (hasExtension) return [base];
    return extensions.map((ext) => base + ext);
  };

  // パス区切りを含む場合はPATH探索を行わない。
  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    for (const candidate of candidatesFor(resolve(command))) {
      if (isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  for (const dir of searchDirectories(env)) {
    for (const candidate of candidatesFor(join(dir, command))) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * PTY起動に使う実行ファイルと引数を決める。
 */
export function resolveCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolveResult {
  const resolvedPath = findExecutable(command, env, platform);
  if (resolvedPath === null) {
    return {
      ok: false,
      message:
        `実行コマンドが見つかりません: ${command}\n` +
        `PATHが通っているか、拡張子付きのパスで指定しているか確認してください。`,
    };
  }

  const ext = extname(resolvedPath).toLowerCase();

  if (platform === 'win32' && BATCH_EXTENSIONS.has(ext)) {
    const comspec = env['ComSpec'] ?? env['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe';
    return {
      ok: true,
      command: {
        file: comspec,
        // /d: AutoRunを無効化、/s /c: 以降をコマンドとして実行。
        // 引数は配列のまま渡し、文字列連結は行わない。
        args: ['/d', '/s', '/c', resolvedPath, ...args],
        resolvedPath,
        viaCmd: true,
      },
    };
  }

  if (platform === 'win32' && (ext === '.ps1' || ext === '.psm1')) {
    return {
      ok: false,
      message:
        `PowerShellスクリプトの直接実行には対応していません: ${resolvedPath}\n` +
        `例: termwatch -- powershell -File "${resolvedPath}"`,
    };
  }

  return {
    ok: true,
    command: { file: resolvedPath, args: [...args], resolvedPath, viaCmd: false },
  };
}
