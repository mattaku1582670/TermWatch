import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PtySession } from '../../src/pty/session.js';
import { findExecutable, resolveCommand } from '../../src/pty/resolve-command.js';

const CHILD = fileURLToPath(new URL('../fixtures/echo-child.mjs', import.meta.url));

function createSession(recordPath: string | null = null): PtySession {
  return new PtySession({
    command: process.execPath,
    args: [CHILD],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    bufferLines: 1000,
    recordPath,
  });
}

/** 指定文字列が出力へ現れるまで待つ。 */
function waitForOutput(session: PtySession, needle: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let accumulated = '';
    const timer = setTimeout(() => {
      reject(new Error(`「${needle}」が現れませんでした。受信内容: ${JSON.stringify(accumulated)}`));
    }, timeoutMs);
    const onData = (data: string): void => {
      accumulated += data;
      if (accumulated.includes(needle)) {
        clearTimeout(timer);
        session.off('data', onData);
        resolve(accumulated);
      }
    };
    session.on('data', onData);
  });
}

function waitForExit(session: PtySession, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('子プロセスが終了しませんでした。')), timeoutMs);
    session.on('exit', (info) => {
      clearTimeout(timer);
      resolve(info.exitCode);
    });
  });
}

describe('PtySession', () => {
  it('PTY内で子プロセスを起動し、出力を受け取る', async () => {
    const session = createSession();
    expect(session.start()).toEqual({ ok: true });
    await waitForOutput(session, 'READY');
    expect(session.processState).toBe('running');
    expect(session.currentSeq).toBeGreaterThan(0);
    session.kill();
    await waitForExit(session);
    session.dispose();
  });

  it('ローカル入力をPTYへ転送し、応答が返る', async () => {
    const session = createSession();
    session.start();
    await waitForOutput(session, 'READY');
    session.write('こんにちは\r');
    const output = await waitForOutput(session, 'ECHO:こんにちは');
    expect(output).toContain('ECHO:こんにちは');
    session.kill();
    await waitForExit(session);
    session.dispose();
  });

  it('子プロセスの終了コードを伝える', async () => {
    const session = createSession();
    session.start();
    await waitForOutput(session, 'READY');
    session.write('EXIT:42\r');
    const code = await waitForExit(session);
    expect(code).toBe(42);
    expect(session.processState).toBe('exited');
    expect(session.exit?.exitCode).toBe(42);
    session.dispose();
  });

  it('終了後の書き込みは失敗を返す', async () => {
    const session = createSession();
    session.start();
    await waitForOutput(session, 'READY');
    session.write('EXIT:0\r');
    await waitForExit(session);
    expect(session.write('x')).toBe(false);
    session.dispose();
  });

  it('存在しないコマンドはエラーを返す', () => {
    const session = new PtySession({
      command: 'termwatch-存在しないコマンド',
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      bufferLines: 100,
      recordPath: null,
    });
    const result = session.start();
    expect(result.ok).toBe(false);
    session.dispose();
  });

  it('--record 指定時のみディスクへ保存する', async () => {
    const recordPath = join(tmpdir(), `termwatch-record-${Date.now()}.log`);
    const session = createSession(recordPath);
    session.start();
    await waitForOutput(session, 'READY');
    session.write('EXIT:0\r');
    await waitForExit(session);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const content = readFileSync(recordPath, 'utf8');
    expect(content).toContain('READY');
    rmSync(recordPath, { force: true });
    session.dispose();
  });

  it('リサイズが例外を投げない', async () => {
    const session = createSession();
    session.start();
    await waitForOutput(session, 'READY');
    expect(() => session.resize(100, 40)).not.toThrow();
    expect(() => session.resize(Number.NaN, 40)).not.toThrow();
    session.kill();
    await waitForExit(session);
    session.dispose();
  });
});

describe('コマンド解決', () => {
  it('node.exe を解決できる', () => {
    const found = findExecutable(process.execPath);
    expect(found).not.toBeNull();
  });

  it('見つからないコマンドはエラーメッセージを返す', () => {
    const result = resolveCommand('termwatch-存在しないコマンド', []);
    expect(result.ok).toBe(false);
  });

  it('引数を配列のまま渡し、シェル連結しない', () => {
    const result = resolveCommand(process.execPath, ['-e', 'console.log(1 & 2)']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.args).toEqual(['-e', 'console.log(1 & 2)']);
    expect(result.command.viaCmd).toBe(false);
  });

  it('Windowsでは .cmd を cmd.exe 経由にする', () => {
    if (process.platform !== 'win32') return;
    const env = { ...process.env };
    const result = resolveCommand('npm', [], env, 'win32');
    if (!result.ok) return; // npmが無い環境ではスキップ
    if (result.command.resolvedPath.toLowerCase().endsWith('.cmd')) {
      expect(result.command.viaCmd).toBe(true);
      expect(result.command.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    }
  });
});
