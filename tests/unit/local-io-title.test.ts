import { describe, expect, it } from 'vitest';
import { LocalIo } from '../../src/pty/local-io.js';
import type { PtySession } from '../../src/pty/session.js';

/**
 * ウィンドウタイトル表示の検証。
 *
 * ペアリングコードは起動バナーにも出るが、子プロセスが画面消去（ESC[2J）を
 * 行うと読めなくなる。タイトルは画面バッファと独立しているため、
 * あとからスマートフォンを接続したいときの確認手段になる。
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

function createIo(useTitleIndicator = true): { io: LocalIo; written: string[] } {
  const written: string[] = [];
  const stdout = {
    isTTY: true,
    columns: 100,
    rows: 30,
    write: (chunk: string): boolean => {
      written.push(chunk);
      return true;
    },
    on: (): void => {},
    off: (): void => {},
  } as unknown as NodeJS.WriteStream;

  const stdin = {
    isTTY: true,
    setRawMode: (): void => {},
    resume: (): void => {},
    pause: (): void => {},
    on: (): void => {},
    off: (): void => {},
  } as unknown as NodeJS.ReadStream;

  const session = { write: (): boolean => true, on: (): void => {} } as unknown as PtySession;

  const io = new LocalIo(session, {
    stdin,
    stdout,
    useTitleIndicator,
    titleBase: 'TermWatch: codex',
  });
  return { io, written };
}

describe('ウィンドウタイトル表示', () => {
  it('ペアリングコードをタイトルへ出す', () => {
    const { io, written } = createIo();
    io.setPairingCode('A7KP-3M9X');
    expect(written).toEqual([`${ESC}]2;TermWatch: codex [ペアリングコード A7KP-3M9X]${BEL}`]);
  });

  it('画面本体へは書き込まない（TUIを壊さない）', () => {
    const { io, written } = createIo();
    io.setPairingCode('A7KP-3M9X');
    io.setRemoteControlIndicator(true);
    // OSC 2（タイトル設定）以外のシーケンスを含まないこと。
    for (const chunk of written) {
      expect(chunk.startsWith(`${ESC}]2;`)).toBe(true);
      expect(chunk.endsWith(BEL)).toBe(true);
    }
  });

  it('失効したらタイトルから消える', () => {
    const { io, written } = createIo();
    io.setPairingCode('A7KP-3M9X');
    written.length = 0;
    io.setPairingCode(null);
    expect(written).toEqual([`${ESC}]2;TermWatch: codex${BEL}`]);
  });

  it('操作モードとペアリングコードを併記する', () => {
    const { io, written } = createIo();
    io.setPairingCode('A7KP-3M9X');
    written.length = 0;
    io.setRemoteControlIndicator(true);
    expect(written).toEqual([
      `${ESC}]2;TermWatch: codex [ペアリングコード A7KP-3M9X] [リモート操作モード有効]${BEL}`,
    ]);
  });

  it('内容が変わらなければ書き込まない', () => {
    const { io, written } = createIo();
    io.setPairingCode('A7KP-3M9X');
    written.length = 0;
    io.setPairingCode('A7KP-3M9X');
    expect(written).toEqual([]);
  });

  it('refreshTitle は子プロセスの上書きに備えて強制的に書き直す', () => {
    const { io, written } = createIo();
    io.setPairingCode('A7KP-3M9X');
    written.length = 0;
    io.refreshTitle();
    expect(written).toEqual([`${ESC}]2;TermWatch: codex [ペアリングコード A7KP-3M9X]${BEL}`]);
  });

  it('TTYでない場合は何も書き込まない', () => {
    const { io, written } = createIo(false);
    io.setPairingCode('A7KP-3M9X');
    io.setRemoteControlIndicator(true);
    io.refreshTitle();
    expect(written).toEqual([]);
  });
});
