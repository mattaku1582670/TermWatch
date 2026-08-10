/**
 * 統合テスト用の子プロセス。
 *
 * PTY経由で受け取った入力をそのまま解釈し、以下を行う。
 * - `EXIT:<code>` を受け取ったらその終了コードで終了する。
 * - それ以外の行は `ECHO:<内容>` として出力する。
 * - 起動時に READY を出力する。
 */

process.stdout.write('READY\r\n');

let pending = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let index;
  while ((index = pending.search(/[\r\n]/)) !== -1) {
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (line.startsWith('EXIT:')) {
      const code = Number.parseInt(line.slice(5), 10);
      process.stdout.write(`BYE\r\n`);
      setTimeout(() => process.exit(Number.isNaN(code) ? 0 : code), 50);
      return;
    }
    if (line.length > 0) {
      process.stdout.write(`ECHO:${line}\r\n`);
    }
  }
});

process.stdin.resume();
