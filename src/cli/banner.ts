/**
 * 起動時にPC側ターミナルへ表示する案内。
 *
 * ペアリングコードはここでしか表示しない。ログ・URL・エラーへは出さない。
 */

export interface BannerInput {
  readonly version: string;
  readonly command: string;
  readonly cwd: string;
  readonly port: number;
  readonly localOnly: boolean;
  readonly recording: boolean;
  readonly controlMinutes: number;
  /** 表示用に整形済みのペアリングコード。--local-only では null。 */
  readonly pairingCode: string | null;
}

/**
 * 端末がTTYでない場合の警告文。
 *
 * Git Bash（MinTTY）から起動すると、Windowsネイティブプログラムの標準入出力は
 * コンソールではなくパイプになるため、raw modeにできず、
 * 端末サイズも取得できない。この状態ではフルスクリーンTUIを正しく操作できない。
 */
export function buildNonTtyWarning(): string {
  return [
    '警告: 標準入力が端末（TTY）ではありません。',
    '  キー入力の転送と端末サイズの取得ができないため、CodexなどのフルスクリーンTUIは',
    '  正しく操作できません。次のいずれかで起動してください。',
    '',
    '  - PowerShell / コマンドプロンプト / VS Code統合ターミナルから起動する（推奨）',
    '  - Git Bash の場合は winpty を挟む: winpty termwatch.cmd -- codex',
    '',
  ].join('\n');
}

export function buildBanner(input: BannerInput): string {
  const lines: string[] = [];
  lines.push(`TermWatch v${input.version}`);
  lines.push(`  実行コマンド : ${input.command}`);
  lines.push(`  作業フォルダー: ${input.cwd}`);

  if (input.localOnly) {
    lines.push('  リモート接続 : 無効（--local-only）');
  } else {
    lines.push(`  待ち受け     : http://127.0.0.1:${input.port} （127.0.0.1のみ）`);
    lines.push(`  操作権の時間 : ${input.controlMinutes}分`);
    lines.push(
      input.recording
        ? '  記録         : 有効（--record 指定。保存先の取り扱いに注意してください）'
        : '  記録         : 無効（ターミナル内容はディスクへ保存されません）',
    );
    lines.push('');
    lines.push('スマートフォンから接続する手順:');
    lines.push('  1. VS Code のコマンドパレットで `Ports: Focus on Ports View` を実行');
    lines.push(`  2. \`Forward a Port\` でポート ${input.port} を転送`);
    lines.push('  3. Port Visibility が `Private` であることを確認（Public にしないこと）');
    lines.push('  4. Forwarded Address をスマートフォンで開く');
    lines.push('  5. PC と同じ GitHub / Microsoft アカウントで認証');
    lines.push('  6. 下のペアリングコードを入力');
    lines.push('');
    if (input.pairingCode !== null) {
      lines.push(`  ペアリングコード: ${input.pairingCode}`);
      lines.push('  （10分、または最初の認証成功で失効します）');
      lines.push('');
      lines.push('  この表示は子プロセスの画面描画で消えることがあります。');
      lines.push('  そのときはターミナルの**ウィンドウタイトル**にも同じコードが出ています。');
    }
  }

  lines.push('');
  lines.push('終了するには子プロセスを終了してください（多くのCLIでは Ctrl+C または /exit）。');
  lines.push('----------------------------------------------------------------');
  return lines.join('\n');
}

/**
 * 子プロセス終了時にPC側へ出す1行。
 *
 * 受け入れ基準では終了コードをPC側とスマートフォン側の両方へ表示する必要がある。
 * 強制終了された場合はこの表示だけが手掛かりになるため、
 * 正常終了（0）かどうかにかかわらず必ず出す。
 */
export function buildExitNotice(
  displayCommand: string,
  info: { readonly exitCode: number; readonly signal: number | null },
): string {
  const signalNote =
    info.signal !== null && info.signal !== 0 ? `、シグナル ${info.signal}` : '';
  return `TermWatch: ${displayCommand} が終了しました（終了コード ${info.exitCode}${signalNote}）`;
}
