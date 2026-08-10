import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/server/schema.js';
import { encodeTextInput } from '../../src/server/server.js';
import { MAX_TEXT_INPUT_BYTES, SPECIAL_KEY_SEQUENCES } from '../../src/shared/protocol.js';

const ESC = String.fromCharCode(0x1b);

describe('parseClientMessage', () => {
  it('正しいメッセージを受理する', () => {
    expect(parseClientMessage('{"type":"ping"}').ok).toBe(true);
    expect(parseClientMessage('{"type":"control.request"}').ok).toBe(true);
    expect(parseClientMessage('{"type":"control.release"}').ok).toBe(true);
    expect(parseClientMessage('{"type":"resume","lastSeq":3,"controlHandle":null}').ok).toBe(true);
    expect(parseClientMessage('{"type":"input.key","key":"ctrl-c"}').ok).toBe(true);
    expect(parseClientMessage('{"type":"input.text","text":"あ","submit":true}').ok).toBe(true);
  });

  it('JSONでない入力を拒否する', () => {
    const result = parseClientMessage('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-message');
  });

  it('配列・null・プリミティブを拒否する', () => {
    expect(parseClientMessage('[]').ok).toBe(false);
    expect(parseClientMessage('null').ok).toBe(false);
    expect(parseClientMessage('"x"').ok).toBe(false);
    expect(parseClientMessage('123').ok).toBe(false);
  });

  it('未知のtypeを拒否する', () => {
    expect(parseClientMessage('{"type":"resize"}').ok).toBe(false);
    expect(parseClientMessage('{"type":"__proto__"}').ok).toBe(false);
    expect(parseClientMessage('{}').ok).toBe(false);
  });

  it('許可されていない特殊キーを拒否する', () => {
    expect(parseClientMessage('{"type":"input.key","key":"ctrl-z"}').ok).toBe(false);
    expect(parseClientMessage('{"type":"input.key","key":123}').ok).toBe(false);
  });

  it('input.text の型を検証する', () => {
    expect(parseClientMessage('{"type":"input.text","text":1,"submit":true}').ok).toBe(false);
    expect(parseClientMessage('{"type":"input.text","text":"a","submit":"yes"}').ok).toBe(false);
    expect(parseClientMessage('{"type":"input.text","text":"a"}').ok).toBe(false);
  });

  it('64KiBちょうどは許可し、超過は too-large で拒否する', () => {
    const exact = JSON.stringify({
      type: 'input.text',
      text: 'a'.repeat(MAX_TEXT_INPUT_BYTES),
      submit: false,
    });
    expect(parseClientMessage(exact).ok).toBe(true);

    const over = JSON.stringify({
      type: 'input.text',
      text: 'a'.repeat(MAX_TEXT_INPUT_BYTES + 1),
      submit: false,
    });
    const result = parseClientMessage(over);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too-large');
  });

  it('マルチバイト文字はバイト数で判定する', () => {
    // 「あ」はUTF-8で3バイト。
    const text = 'あ'.repeat(Math.floor(MAX_TEXT_INPUT_BYTES / 3) + 1);
    const result = parseClientMessage(JSON.stringify({ type: 'input.text', text, submit: false }));
    expect(result.ok).toBe(false);
  });

  it('resume の lastSeq を検証する', () => {
    expect(parseClientMessage('{"type":"resume","lastSeq":-1}').ok).toBe(false);
    expect(parseClientMessage('{"type":"resume","lastSeq":1.5}').ok).toBe(false);
    expect(parseClientMessage('{"type":"resume","lastSeq":"3"}').ok).toBe(false);
  });

  it('controlHandle の型と長さを検証する', () => {
    expect(parseClientMessage('{"type":"resume","lastSeq":0,"controlHandle":5}').ok).toBe(false);
    const long = JSON.stringify({ type: 'resume', lastSeq: 0, controlHandle: 'x'.repeat(300) });
    expect(parseClientMessage(long).ok).toBe(false);
  });
});

describe('特殊キーのエンコード', () => {
  it('危険キーを含む各キーが正しいバイト列になる', () => {
    expect(SPECIAL_KEY_SEQUENCES['ctrl-c']).toBe(String.fromCharCode(0x03));
    expect(SPECIAL_KEY_SEQUENCES.enter).toBe('\r');
    expect(SPECIAL_KEY_SEQUENCES.escape).toBe(ESC);
    expect(SPECIAL_KEY_SEQUENCES.tab).toBe('\t');
    expect(SPECIAL_KEY_SEQUENCES.up).toBe(`${ESC}[A`);
    expect(SPECIAL_KEY_SEQUENCES.down).toBe(`${ESC}[B`);
    expect(SPECIAL_KEY_SEQUENCES.right).toBe(`${ESC}[C`);
    expect(SPECIAL_KEY_SEQUENCES.left).toBe(`${ESC}[D`);
    expect(SPECIAL_KEY_SEQUENCES.y).toBe('y');
    expect(SPECIAL_KEY_SEQUENCES.n).toBe('n');
  });
});

describe('encodeTextInput', () => {
  it('単一行はそのまま送り、最後にCRを付ける', () => {
    expect(encodeTextInput('hello', true)).toBe('hello\r');
    expect(encodeTextInput('hello', false)).toBe('hello');
  });

  it('複数行は bracketed paste で囲む', () => {
    const encoded = encodeTextInput('一行目\n二行目', true);
    expect(encoded.startsWith(`${ESC}[200~`)).toBe(true);
    expect(encoded).toContain(`${ESC}[201~`);
    expect(encoded.endsWith('\r')).toBe(true);
    // 途中の改行はCRへ変換され、bracketed paste内に収まる。
    expect(encoded).toBe(`${ESC}[200~一行目\r二行目${ESC}[201~\r`);
  });

  it('CRLFを正規化する', () => {
    expect(encodeTextInput('a\r\nb', false)).toBe(`${ESC}[200~a\rb${ESC}[201~`);
  });

  it('空文字でも submit なら Enter だけ送る', () => {
    expect(encodeTextInput('', true)).toBe('\r');
    expect(encodeTextInput('', false)).toBe('');
  });
});
