/**
 * CLI引数解析。
 *
 * 構文: termwatch [TermWatchオプション] -- <実行コマンド> [引数...]
 *
 * `--` 以降は一切解釈せず、そのままargv配列として子プロセスへ渡す。
 * シェルを経由しないため、コマンド文字列の連結によるインジェクションは発生しない。
 */

export const DEFAULT_PORT = 43821;
export const DEFAULT_BUFFER_LINES = 10_000;
export const DEFAULT_CONTROL_MINUTES = 10;

export interface ParsedOptions {
  readonly cwd: string | null;
  readonly port: number;
  readonly bufferLines: number;
  readonly controlMinutes: number;
  readonly recordPath: string | null;
  readonly localOnly: boolean;
  /** 出力停止時にスマートフォンへ通知するか。 */
  readonly notify: boolean;
  /** 通知までの静止時間（秒）。 */
  readonly notifyIdleSeconds: number;
}

export type ParseResult =
  | { readonly kind: 'run'; readonly options: ParsedOptions; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly message: string };

/** 数値オプションを検証付きで読む。 */
function parseIntegerOption(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number | { error: string } {
  if (raw === undefined) {
    return { error: `${name} には値が必要です。` };
  }
  if (!/^-?\d+$/.test(raw)) {
    return { error: `${name} には整数を指定してください（指定値: ${raw}）。` };
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { error: `${name} は ${min} 以上 ${max} 以下で指定してください（指定値: ${raw}）。` };
  }
  return value;
}

function isErr(v: unknown): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in v;
}

/**
 * argv（実行ファイル名を除いた配列）を解析する。
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  let cwd: string | null = null;
  let port = DEFAULT_PORT;
  let bufferLines = DEFAULT_BUFFER_LINES;
  let controlMinutes = DEFAULT_CONTROL_MINUTES;
  let recordPath: string | null = null;
  let localOnly = false;
  let notify = true;
  let notifyIdleSeconds = 30;

  let i = 0;
  let separatorFound = false;

  for (; i < argv.length; i += 1) {
    const token = argv[i] as string;

    if (token === '--') {
      separatorFound = true;
      i += 1;
      break;
    }

    switch (token) {
      case '--help':
      case '-h':
        return { kind: 'help' };

      case '--version':
      case '-v':
        return { kind: 'version' };

      case '--local-only':
        localOnly = true;
        break;

      case '--cwd': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return { kind: 'error', message: '--cwd にはフォルダーのパスが必要です。' };
        }
        cwd = value;
        i += 1;
        break;
      }

      case '--record': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return { kind: 'error', message: '--record には保存先ファイルのパスが必要です。' };
        }
        recordPath = value;
        i += 1;
        break;
      }

      case '--port': {
        const result = parseIntegerOption('--port', argv[i + 1], 1, 65535);
        if (isErr(result)) return { kind: 'error', message: result.error };
        port = result;
        i += 1;
        break;
      }

      case '--buffer-lines': {
        const result = parseIntegerOption('--buffer-lines', argv[i + 1], 100, 1_000_000);
        if (isErr(result)) return { kind: 'error', message: result.error };
        bufferLines = result;
        i += 1;
        break;
      }

      case '--control-minutes': {
        const result = parseIntegerOption('--control-minutes', argv[i + 1], 1, 240);
        if (isErr(result)) return { kind: 'error', message: result.error };
        controlMinutes = result;
        i += 1;
        break;
      }

      case '--no-notify': {
        notify = false;
        break;
      }

      case '--notify-idle-seconds': {
        const raw = argv[i + 1];
        i += 1;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 3600) {
          return {
            kind: 'error',
            message: '--notify-idle-seconds は1〜3600の整数で指定してください。',
          };
        }
        notifyIdleSeconds = value;
        break;
      }

      default:
        if (token.startsWith('-')) {
          return { kind: 'error', message: `不明なオプションです: ${token}` };
        }
        return {
          kind: 'error',
          message:
            `実行コマンドは -- の後ろに指定してください（例: termwatch -- codex）。` +
            `\n解釈できなかった引数: ${token}`,
        };
    }
  }

  if (!separatorFound) {
    return {
      kind: 'error',
      message: '実行コマンドが指定されていません。例: termwatch -- codex',
    };
  }

  const rest = argv.slice(i);
  const command = rest[0];
  if (command === undefined || command.length === 0) {
    return {
      kind: 'error',
      message: '-- の後ろに実行コマンドを指定してください。例: termwatch -- codex',
    };
  }

  return {
    kind: 'run',
    options: { cwd, port, bufferLines, controlMinutes, recordPath, localOnly, notify, notifyIdleSeconds },
    command,
    args: rest.slice(1),
  };
}

export const HELP_TEXT = `TermWatch - CLIエージェントをスマートフォンから監視・操作する

使い方:
  termwatch [オプション] -- <実行コマンド> [引数...]

例:
  termwatch -- codex
  termwatch -- codex resume --last
  termwatch -- claude
  termwatch --port 43821 --control-minutes 10 -- codex

オプション:
  --cwd <path>              子プロセスの作業フォルダー（既定: 現在のフォルダー）
  --port <number>           ローカルWebサーバーのポート（既定: ${DEFAULT_PORT}）
  --buffer-lines <number>   再接続用に保持する最大表示行数（既定: ${DEFAULT_BUFFER_LINES}）
  --control-minutes <number> スマートフォン操作権の有効時間・分（既定: ${DEFAULT_CONTROL_MINUTES}）
  --record <path>           指定時のみ生PTY出力をファイルへ保存する（既定: 保存しない）
  --local-only              スマートフォン接続を無効化し、ローカル実行だけを行う
  --notify-idle-seconds <秒> 出力停止から通知までの時間（既定: 30）
  --no-notify               スマートフォンへの通知を無効化する
  --help, -h                このヘルプを表示する
  --version, -v             バージョンを表示する

Webサーバーは 127.0.0.1 のみで待ち受けます。スマートフォンから接続するには
VS Code の Ports ビューで Private のポート転送を手動設定してください。
詳細は README.md を参照してください。
`;
