import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * ビルド済みのポータブル版を、常用フォルダーへ配置する。
 *
 * 配置先は既定で `C:\tools\TermWatch`。環境変数 `TERMWATCH_INSTALL_DIR` で変更できる。
 *
 * `dist/` はビルドのたびに作り直される場所なので、PATH を通して常用するには
 * ここでコピーした安定した場所を指すほうがよい。
 *
 * PATH の設定は行わない（環境変数の変更は利用者が明示的に行う）。
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'dist', 'TermWatch-win-x64');
const target = process.env['TERMWATCH_INSTALL_DIR'] ?? 'C:\\tools\\TermWatch';

if (process.platform !== 'win32') {
  console.error('[install:local] Windows 上で実行してください。');
  process.exit(1);
}

if (!existsSync(join(source, 'termwatch.cmd'))) {
  console.error(
    '[install:local] ポータブル版が見つかりません。先に `npm run package:win` を実行してください。',
  );
  process.exit(1);
}

// 配置先を上書きする。
// フォルダーごと削除すると、実行中のTermWatchがある場合に必ず失敗するため、
// 中身の上書きコピーで更新する。
try {
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
} catch (error) {
  const code = /** @type {NodeJS.ErrnoException} */ (error).code;
  // EPIPE は、実行中プロセスがロックしている .node / .exe を上書きしようとしたときに出る。
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'EPIPE') {
    console.error(
      `[install:local] 配置先のファイルを更新できません: ${target}\n` +
        '  TermWatch がまだ実行中の可能性があります。' +
        '起動中のセッションをすべて終了してから、もう一度実行してください。\n' +
        '  実行中かどうかは PowerShell で次のように確認できます:\n' +
        `    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `Where-Object { $_.ExecutablePath -like '${target}*' }`,
    );
    process.exit(1);
  }
  throw error;
}

console.log(`[install:local] 配置しました: ${target}`);
console.log('[install:local] PATH に未登録の場合は、次を一度だけ実行してください（VS Code の再起動が必要）:');
console.log(
  `  [Environment]::SetEnvironmentVariable('Path', ` +
    `[Environment]::GetEnvironmentVariable('Path','User') + ';${target}', 'User')`,
);
