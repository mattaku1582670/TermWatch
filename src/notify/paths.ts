import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 設定ファイルの置き場所。
 *
 * TermWatch にとって初めての永続状態になる。置くのは VAPID 鍵と購読情報だけで、
 * ターミナルの内容は一切保存しない（--record の方針は変えない）。
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env['APPDATA'];
  if (typeof appData === 'string' && appData.length > 0) {
    return join(appData, 'TermWatch');
  }
  return join(homedir(), '.termwatch');
}
