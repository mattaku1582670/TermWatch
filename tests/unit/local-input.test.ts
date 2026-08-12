import { describe, expect, it } from 'vitest';
import {
  LocalIo,
  decodeWin32InputMode,
  isIncompleteEscapeSequence,
} from '../../src/pty/local-io.js';
import type { PtySession } from '../../src/pty/session.js';

/**
 * PC側入力の転送検証。
 *
 * エスケープシーケンス（矢印キーなど）が分割して届いても、
 * PTYへは1回の書き込みでまとめて渡す必要がある。
 * 分割したまま渡すと、ConPTY の win32 input mode が
 * 「Escキー」＋「文字」として解釈し、矢印キーが `[A` になってしまう。
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  io: LocalIo;
  /** PTYへ書き込まれた内容（1要素＝1回の書き込み）。 */
  writes: string[];
  /** 標準入力からのデータ到着を模擬する。 */
  input: (text: string) => void;
}

function createIo(): Harness {
  const writes: string[] = [];
  let stdinHandler: ((chunk: Buffer) => void) | null = null;

  const stdin = {
    isTTY: true,
    setRawMode: (): void => {},
    resume: (): void => {},
    pause: (): void => {},
    on: (event: string, handler: (chunk: Buffer) => void): void => {
      if (event === 'data') stdinHandler = handler;
    },
    off: (): void => {},
  } as unknown as NodeJS.ReadStream;

  const stdout = {
    isTTY: false,
    columns: 120,
    rows: 30,
    write: (): boolean => true,
    on: (): void => {},
    off: (): void => {},
  } as unknown as NodeJS.WriteStream;

  const session = {
    write: (data: string): boolean => {
      writes.push(data);
      return true;
    },
    on: (): void => {},
  } as unknown as PtySession;

  const io = new LocalIo(session, {
    stdin,
    stdout,
    useTitleIndicator: false,
    titleBase: 'TermWatch',
  });
  io.attach();

  return {
    io,
    writes,
    input: (text: string): void => {
      stdinHandler?.(Buffer.from(text, 'utf8'));
    },
  };
}

describe('isIncompleteEscapeSequence', () => {
  it('通常の文字は未完ではない', () => {
    expect(isIncompleteEscapeSequence('hello')).toBe(false);
    expect(isIncompleteEscapeSequence('')).toBe(false);
    expect(isIncompleteEscapeSequence('こんにちは')).toBe(false);
  });

  it('ESC 単独は未完とみなす', () => {
    expect(isIncompleteEscapeSequence(ESC)).toBe(true);
    expect(isIncompleteEscapeSequence(`abc${ESC}`)).toBe(true);
  });

  it('CSI が終端していなければ未完', () => {
    expect(isIncompleteEscapeSequence(`${ESC}[`)).toBe(true);
    expect(isIncompleteEscapeSequence(`${ESC}[1;2`)).toBe(true);
  });

  it('CSI が終端していれば完結', () => {
    expect(isIncompleteEscapeSequence(`${ESC}[A`)).toBe(false);
    expect(isIncompleteEscapeSequence(`${ESC}[1;2H`)).toBe(false);
  });

  it('SS3 は1文字そろえば完結', () => {
    expect(isIncompleteEscapeSequence(`${ESC}O`)).toBe(true);
    expect(isIncompleteEscapeSequence(`${ESC}OP`)).toBe(false);
  });

  it('OSC は BEL か ST で完結', () => {
    expect(isIncompleteEscapeSequence(`${ESC}]0;title`)).toBe(true);
    expect(isIncompleteEscapeSequence(`${ESC}]0;title${BEL}`)).toBe(false);
  });

  it('ESC + 1文字（Alt+キー）は完結', () => {
    expect(isIncompleteEscapeSequence(`${ESC}a`)).toBe(false);
  });
});

describe('decodeWin32InputMode', () => {
  // 実測ログ（D-019）から採取した、VS Code ターミナルが送ってきた実際のバイト列。
  const UP = `${ESC}[0;0;27;1;0;1_${ESC}[0;0;91;1;0;1_${ESC}[0;0;65;1;0;1_`;
  const DOWN = `${ESC}[0;0;27;1;0;1_${ESC}[0;0;91;1;0;1_${ESC}[0;0;66;1;0;1_`;
  const RIGHT = `${ESC}[0;0;27;1;0;1_${ESC}[0;0;91;1;0;1_${ESC}[0;0;67;1;0;1_`;
  const LEFT = `${ESC}[0;0;27;1;0;1_${ESC}[0;0;91;1;0;1_${ESC}[0;0;68;1;0;1_`;
  // Ctrl+C は押下と離すの2レコードで届く。
  const CTRL_C = `${ESC}[67;0;3;1;8;1_${ESC}[67;0;3;0;8;1_`;

  it('矢印キーを本来のエスケープシーケンスへ戻す', () => {
    expect(decodeWin32InputMode(UP)).toBe(`${ESC}[A`);
    expect(decodeWin32InputMode(DOWN)).toBe(`${ESC}[B`);
    expect(decodeWin32InputMode(RIGHT)).toBe(`${ESC}[C`);
    expect(decodeWin32InputMode(LEFT)).toBe(`${ESC}[D`);
  });

  it('離すイベントを捨て、Ctrl+Cを1回だけにする', () => {
    expect(decodeWin32InputMode(CTRL_C)).toBe(String.fromCharCode(3));
  });

  it('文字を伴わないキー（Uc=0）は捨てる', () => {
    // Shift 単独の押下。
    expect(decodeWin32InputMode(`${ESC}[16;42;0;1;16;1_`)).toBe('');
  });

  it('繰り返し回数のぶんだけ複製する', () => {
    expect(decodeWin32InputMode(`${ESC}[65;30;97;1;0;3_`)).toBe('aaa');
  });

  it('win32 input mode ではない入力には手を触れない', () => {
    expect(decodeWin32InputMode('abc')).toBe('abc');
    expect(decodeWin32InputMode(`${ESC}[A`)).toBe(`${ESC}[A`);
    expect(decodeWin32InputMode(`${ESC}[200~text${ESC}[201~`)).toBe(
      `${ESC}[200~text${ESC}[201~`,
    );
    // 項目数が足りないものは対象外とみなす。
    expect(decodeWin32InputMode(`${ESC}[1;2_`)).toBe(`${ESC}[1;2_`);
  });

  it('日本語などBMP外も含めて文字を復元する', () => {
    const a = 'あ'.codePointAt(0) ?? 0;
    expect(decodeWin32InputMode(`${ESC}[0;0;${a};1;0;1_`)).toBe('あ');
  });
});

describe('PC側入力の転送', () => {
  it('通常の文字はそのまま即座に書き込む', () => {
    const { writes, input } = createIo();
    input('abc');
    expect(writes).toEqual(['abc']);
  });

  it('分割された矢印キーを1回の書き込みへまとめる', async () => {
    const { writes, input } = createIo();
    // 端末が ESC と [A を別々に届けた場合。
    input(ESC);
    expect(writes).toEqual([]); // まだ書かない
    input('[A');
    expect(writes).toEqual([`${ESC}[A`]);
    await sleep(30);
    // 余計な書き込みは発生しない。
    expect(writes).toEqual([`${ESC}[A`]);
  });

  it('まとまって届いた矢印キーはそのまま書き込む', () => {
    const { writes, input } = createIo();
    input(`${ESC}[B`);
    expect(writes).toEqual([`${ESC}[B`]);
  });

  it('単独の Esc キーは待ち時間の後に送る', async () => {
    const { writes, input } = createIo();
    input(ESC);
    expect(writes).toEqual([]);
    await sleep(40);
    expect(writes).toEqual([ESC]);
  });

  it('通常文字とエスケープが混ざっても順序を保つ', () => {
    const { writes, input } = createIo();
    input(`ab${ESC}[C`);
    expect(writes).toEqual([`ab${ESC}[C`]);
  });

  it('win32 input mode の矢印キーを1回の書き込みで渡す', () => {
    const { writes, input } = createIo();
    input(`${ESC}[0;0;27;1;0;1_${ESC}[0;0;91;1;0;1_${ESC}[0;0;65;1;0;1_`);
    // 3打鍵ではなく、矢印キー1個として届かなければならない。
    expect(writes).toEqual([`${ESC}[A`]);
  });

  it('restore で保留中の入力を取りこぼさない', () => {
    const { io, writes, input } = createIo();
    input(ESC);
    expect(writes).toEqual([]);
    io.restore();
    expect(writes).toEqual([ESC]);
  });
});
