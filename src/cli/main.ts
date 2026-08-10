import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELP_TEXT, parseArgs } from './args.js';
import { resolveWorkdir } from './workdir.js';
import { buildBanner, buildNonTtyWarning } from './banner.js';
import { LocalIo } from '../pty/local-io.js';
import { PtySession } from '../pty/session.js';
import { SessionAuth } from '../security/tokens.js';
import { TermWatchServer } from '../server/server.js';

/**
 * TermWatch のエントリーポイント。
 *
 * 終了時にはどの経路（正常終了・例外・シグナル）でも
 * raw mode の復元、トークンの無効化、サーバー・PTY の解放を行う。
 */

const EXIT_USAGE = 2;
const EXIT_COMMAND_NOT_FOUND = 127;
const EXIT_SERVER_ERROR = 3;
/** 子プロセス終了を通知するための猶予（ミリ秒）。 */
const SHUTDOWN_GRACE_MS = 3000;

function readVersion(): string {
  // 開発時（dist/app/cli/main.js）とポータブル版（app/cli/main.js）の双方を試す。
  for (const relative of ['../../../package.json', '../../package.json']) {
    try {
      const url = new URL(relative, import.meta.url);
      const raw: unknown = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
      if (typeof raw === 'object' && raw !== null) {
        const version = (raw as Record<string, unknown>)['version'];
        if (typeof version === 'string') return version;
      }
    } catch {
      // パッケージ情報が読めなくても動作は継続する。
    }
  }
  return '1.0.0';
}

function webRootPath(): string {
  return fileURLToPath(new URL('../../web/', import.meta.url));
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.kind === 'help') {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n\n${HELP_TEXT}`);
    return EXIT_USAGE;
  }

  const { options, command, args } = parsed;

  const workdir = resolveWorkdir(options.cwd);
  if (!workdir.ok) {
    process.stderr.write(`${workdir.message}\n`);
    return EXIT_USAGE;
  }

  const version = readVersion();
  const size = LocalIo.currentSize(process.stdout);

  const session = new PtySession({
    command,
    args,
    cwd: workdir.path,
    cols: size.cols,
    rows: size.rows,
    bufferLines: options.bufferLines,
    recordPath: options.recordPath,
  });

  const auth = new SessionAuth();
  let server: TermWatchServer | null = null;

  if (!options.localOnly) {
    server = new TermWatchServer({
      port: options.port,
      webRoot: webRootPath(),
      auth,
      session,
      controlMinutes: options.controlMinutes,
      bufferLines: options.bufferLines,
      version,
    });
    const listenResult = await server.listen();
    if (!listenResult.ok) {
      process.stderr.write(`${listenResult.message}\n`);
      auth.revoke();
      session.dispose();
      return EXIT_SERVER_ERROR;
    }
  }

  const started = session.start();
  if (!started.ok) {
    process.stderr.write(`${started.message}\n`);
    auth.revoke();
    await server?.close();
    session.dispose();
    return EXIT_COMMAND_NOT_FOUND;
  }

  const localIo = new LocalIo(session, {
    stdin: process.stdin,
    stdout: process.stdout,
    useTitleIndicator: process.stdout.isTTY === true,
    titleBase: `TermWatch: ${session.displayCommand}`,
  });

  process.stdout.write(
    `${buildBanner({
      version,
      command: session.displayCommand,
      cwd: workdir.path,
      port: options.port,
      localOnly: options.localOnly,
      recording: options.recordPath !== null,
      controlMinutes: options.controlMinutes,
      pairingCode: options.localOnly ? null : auth.getPairingCodeForDisplay(),
    })}\n`,
  );

  if (process.stdin.isTTY !== true) {
    process.stdout.write(`${buildNonTtyWarning()}\n`);
  }

  localIo.attach();

  if (server !== null) {
    server.onControlActiveChange = (active: boolean): void => {
      localIo.setRemoteControlIndicator(active);
    };
  }

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    auth.revoke();
    localIo.restore();
    await server?.close();
    session.dispose();
  };

  const exitCode = await new Promise<number>((resolvePromise) => {
    const finish = (code: number): void => {
      resolvePromise(code);
    };

    session.on('exit', (info) => {
      // 終了コードをクライアントへ通知するための猶予を置く。
      // このタイマーは unref しない（猶予中にプロセスが終了しないようにするため）。
      server?.flushFinalStatus();
      const grace = server === null ? 0 : SHUTDOWN_GRACE_MS;
      setTimeout(() => finish(info.exitCode), grace);
    });

    // PTYの回復可能な問題は握りつぶさず、致命扱いにもしない。
    session.on('warning', () => {
      // 秘密情報が混ざる恐れがあるため内容は出力しない。
    });

    const terminate = (): void => {
      session.kill();
      // 子プロセスの終了イベントを待つが、来なければ強制的に閉じる。
      setTimeout(() => finish(130), SHUTDOWN_GRACE_MS);
    };

    process.on('SIGTERM', terminate);
    process.on('SIGBREAK', terminate);
    process.on('SIGHUP', terminate);

    // PC側ターミナルが閉じられた場合は子プロセスも終了させる（孤児化させない）。
    process.stdin.on('close', terminate);

    process.on('uncaughtException', (error) => {
      localIo.restore();
      process.stderr.write(`TermWatch内部エラー: ${(error as Error).message}\n`);
      session.kill();
      finish(1);
    });
  });

  await cleanup();
  return exitCode;
}

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
};

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      // 標準出力の書き出しを終えてから終了する。
      // 残ったハンドル（node-ptyの補助スレッド等）で終了が妨げられないよう、
      // 短い猶予のあとに明示的に終了する。
      setTimeout(() => process.exit(code), 100);
    })
    .catch((error: unknown) => {
      process.stderr.write(`TermWatch起動エラー: ${(error as Error).message}\n`);
      process.exit(1);
    });
}
