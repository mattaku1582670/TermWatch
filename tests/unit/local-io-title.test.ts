import { describe, expect, it } from 'vitest';
import { LocalIo, nextVtState } from '../../src/pty/local-io.js';
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

interface Harness {
  io: LocalIo;
  written: string[];
  /** PTY出力が届いたことを模擬する。 */
  emitOutput: (data: string) => void;
}

function createIo(useTitleIndicator = true): Harness {
  const written: string[] = [];
  let dataHandler: ((data: string) => void) | null = null;
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

  const session = {
    write: (): boolean => true,
    on: (event: string, handler: (data: string) => void): void => {
      if (event === 'data') dataHandler = handler;
    },
  } as unknown as PtySession;

  const io = new LocalIo(session, {
    stdin,
    stdout,
    useTitleIndicator,
    titleBase: 'TermWatch: codex',
  });
  io.attach();
  written.length = 0;

  return {
    io,
    written,
    emitOutput: (data: string): void => {
      dataHandler?.(data);
      // 出力そのものは検証対象ではないので取り除く。
      const index = written.indexOf(data);
      if (index >= 0) written.splice(index, 1);
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  it('PTY出力の直後はタイトルを書き込まない（エスケープシーケンスへの割り込み防止）', () => {
    const { io, written, emitOutput } = createIo();
    emitOutput('子プロセスの出力');
    io.setPairingCode('A7KP-3M9X');
    // 出力中なので保留され、書き込まれない。
    expect(written).toEqual([]);
  });

  it('出力が落ち着いてから保留分を書き込む', async () => {
    const { io, written, emitOutput } = createIo();
    emitOutput('子プロセスの出力');
    io.setPairingCode('A7KP-3M9X');
    expect(written).toEqual([]);

    await sleep(80);
    io.refreshTitle();
    expect(written).toEqual([`${ESC}]2;TermWatch: codex [ペアリングコード A7KP-3M9X]${BEL}`]);
  });

  it('表示するものが無ければ定期更新で何も書き込まない', () => {
    const { io, written } = createIo();
    io.refreshTitle();
    io.refreshTitle();
    expect(written).toEqual([]);
  });

  it('TTYでない場合は何も書き込まない', () => {
    const { io, written } = createIo(false);
    io.setPairingCode('A7KP-3M9X');
    io.setRemoteControlIndicator(true);
    io.refreshTitle();
    expect(written).toEqual([]);
  });
});

describe('nextVtState', () => {
  const E = String.fromCharCode(0x1b);
  const BELL = String.fromCharCode(0x07);
  const ST = E + String.fromCharCode(0x5c);

  it('通常の文字では ground のまま', () => {
    expect(nextVtState('hello', 'ground')).toBe('ground');
  });

  it('完結したシーケンスの後は ground に戻る', () => {
    expect(nextVtState(`${E}[2J`, 'ground')).toBe('ground');
    expect(nextVtState(`${E}[?2004h`, 'ground')).toBe('ground');
    expect(nextVtState(`${E}OP`, 'ground')).toBe('ground');
    expect(nextVtState(`${E}]0;title${BELL}`, 'ground')).toBe('ground');
    expect(nextVtState(`${E}]0;title${ST}`, 'ground')).toBe('ground');
  });

  it('未完のシーケンスの途中を検出する', () => {
    // ここでタイトルを書くと断片が表示されてしまう。
    expect(nextVtState(`${E}[`, 'ground')).toBe('csi');
    expect(nextVtState(`${E}[?2004`, 'ground')).toBe('csi');
    expect(nextVtState(E, 'ground')).toBe('escape');
    expect(nextVtState(`${E}]0;tit`, 'ground')).toBe('osc');
  });

  it('チャンクを跨いで状態を持ち越す', () => {
    // 子プロセスの出力は境界で分割される。1回目で途中、2回目で完結。
    const first = nextVtState(`${E}[?2004`, 'ground');
    expect(first).toBe('csi');
    expect(nextVtState('h', first)).toBe('ground');
  });

  it('OSC 内の ESC が本文でも状態を失わない', () => {
    expect(nextVtState(`${E}]0;a${E}b`, 'ground')).toBe('osc');
  });
});
