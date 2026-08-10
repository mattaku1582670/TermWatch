import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Windows x64 向けポータブル版の生成。
 *
 * 出力:
 *   dist/TermWatch-win-x64/
 *   dist/TermWatch-win-x64.zip
 *
 * 方針:
 * - Node.js ランタイムは現在実行中の node.exe を丸ごと同梱する
 *   （Windowsのnode.exeは単体で動作するため、追加ファイルは不要）。
 * - node-pty のネイティブモジュールは N-API (node-addon-api) 版のプリビルドを
 *   同梱するため、同梱Node.jsとのABI不一致が起きにくい。
 * - グローバルnpmインストール、サービス登録、レジストリ変更は行わない。
 * - アンインストールは展開フォルダーの削除だけで完了する。
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const outDir = join(dist, 'TermWatch-win-x64');
const zipPath = join(dist, 'TermWatch-win-x64.zip');

function fail(message) {
  console.error(`[package:win] ${message}`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  fail('ポータブル版の生成は Windows 上で実行してください。');
}
if (process.arch !== 'x64') {
  fail(`x64 環境で実行してください（現在: ${process.arch}）。`);
}
if (!existsSync(join(dist, 'app', 'cli', 'main.js'))) {
  fail('dist/app が見つかりません。先に `npm run build` を実行してください。');
}
if (!existsSync(join(dist, 'web', 'index.html'))) {
  fail('dist/web が見つかりません。先に `npm run build` を実行してください。');
}

rmSync(outDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(outDir, { recursive: true });

// --- アプリ本体とWebアセット ---
cpSync(join(dist, 'app'), join(outDir, 'app'), { recursive: true });
cpSync(join(dist, 'web'), join(outDir, 'web'), { recursive: true });

// --- Node.js ランタイム ---
mkdirSync(join(outDir, 'runtime'), { recursive: true });
cpSync(process.execPath, join(outDir, 'runtime', 'node.exe'));

// --- 実行時依存 ---
const runtimeDeps = ['node-pty', 'ws', 'node-addon-api'];
for (const dep of runtimeDeps) {
  const source = join(root, 'node_modules', dep);
  if (!existsSync(source)) {
    fail(`依存関係が見つかりません: ${dep}（npm ci を実行してください）`);
  }
  cpSync(source, join(outDir, 'node_modules', dep), { recursive: true });
}

// 不要なプリビルド（他プラットフォーム向け）を削除してサイズを抑える。
const prebuilds = join(outDir, 'node_modules', 'node-pty', 'prebuilds');
if (existsSync(prebuilds)) {
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64']) {
    rmSync(join(prebuilds, platform), { recursive: true, force: true });
  }
}
if (!existsSync(join(prebuilds, 'win32-x64', 'pty.node'))) {
  fail('node-pty の win32-x64 プリビルドが見つかりません。');
}

// --- package.json（ESM解決のため type: module が必要） ---
const sourcePkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(
  join(outDir, 'package.json'),
  `${JSON.stringify(
    {
      name: sourcePkg.name,
      version: sourcePkg.version,
      description: sourcePkg.description,
      type: 'module',
      private: true,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

// --- 起動スクリプト ---
const cmd = [
  '@echo off',
  'setlocal',
  // cmd.exe はコードページ依存で非ASCIIコメントを誤解釈するため、ここは英語のみにする。
  'rem TermWatch portable launcher.',
  'rem Uses the bundled Node.js runtime; no system Node.js installation required.',
  'set "TERMWATCH_HOME=%~dp0"',
  'rem Double-clicking from Explorer passes no arguments. Show help and keep the',
  'rem window open so the user can read it instead of it closing instantly.',
  'if "%~1"=="" (',
  '  "%TERMWATCH_HOME%runtime\\node.exe" "%TERMWATCH_HOME%app\\cli\\main.js" --help',
  '  echo.',
  '  pause',
  '  exit /b 2',
  ')',
  '"%TERMWATCH_HOME%runtime\\node.exe" "%TERMWATCH_HOME%app\\cli\\main.js" %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');
writeFileSync(join(outDir, 'termwatch.cmd'), cmd, 'utf8');

// PowerShell 用の .ps1 ランチャーは同梱しない。
// PowerShell は PATH 解決時に .ps1 を .cmd より優先するため、
// termwatch.ps1 があると `termwatch` が .ps1 に解決され、
// 実行ポリシー（既定の Restricted / RemoteSigned）で失敗してしまう。
// termwatch.cmd は PowerShell からもそのまま実行できるため .cmd のみとする。
rmSync(join(outDir, 'termwatch.ps1'), { force: true });

// --- ライセンス ---
const licenseDir = join(outDir, 'LICENSES');
mkdirSync(licenseDir, { recursive: true });

for (const dep of runtimeDeps) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    const source = join(root, 'node_modules', dep, name);
    if (existsSync(source)) {
      cpSync(source, join(licenseDir, `${dep}-${name}`));
      break;
    }
  }
}

writeFileSync(
  join(licenseDir, 'README.txt'),
  [
    'このフォルダーには、TermWatch ポータブル版へ同梱したソフトウェアのライセンスが含まれます。',
    '',
    `- Node.js ランタイム (runtime/node.exe, ${process.version}): https://github.com/nodejs/node/blob/main/LICENSE`,
    '- node-pty (MIT): https://github.com/microsoft/node-pty',
    '- ws (MIT): https://github.com/websockets/ws',
    '- node-addon-api (MIT): https://github.com/nodejs/node-addon-api',
    '- @xterm/xterm (MIT, web/assets へバンドル済み): https://github.com/xtermjs/xterm.js',
    '',
    'Node.js のライセンス全文は https://github.com/nodejs/node の LICENSE を参照してください。',
    '',
  ].join('\r\n'),
  'utf8',
);

// --- README ---
for (const name of ['README.md', 'SECURITY.md']) {
  const source = join(root, name);
  if (existsSync(source)) cpSync(source, join(outDir, name));
}

// --- ZIP ---
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path "${outDir}\\*" -DestinationPath "${zipPath}" -Force`,
  ],
  { stdio: 'inherit' },
);

console.log(`[package:win] 生成しました:\n  ${outDir}\n  ${zipPath}`);
