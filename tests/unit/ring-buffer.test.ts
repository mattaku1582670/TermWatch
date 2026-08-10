import { describe, expect, it } from 'vitest';
import { OutputRingBuffer } from '../../src/pty/ring-buffer.js';

describe('OutputRingBuffer', () => {
  it('シーケンス番号を1から連番で割り当てる', () => {
    const buffer = new OutputRingBuffer({ maxLines: 100 });
    expect(buffer.push('a')).toBe(1);
    expect(buffer.push('b')).toBe(2);
    expect(buffer.currentSeq).toBe(2);
  });

  it('空文字はシーケンスを進めない', () => {
    const buffer = new OutputRingBuffer({ maxLines: 100 });
    buffer.push('a');
    expect(buffer.push('')).toBe(1);
    expect(buffer.currentSeq).toBe(1);
  });

  it('afterSeq より後ろだけを返す', () => {
    const buffer = new OutputRingBuffer({ maxLines: 100 });
    buffer.push('one');
    buffer.push('two');
    buffer.push('three');
    const snapshot = buffer.snapshotSince(1);
    expect(snapshot.data).toBe('twothree');
    expect(snapshot.seq).toBe(3);
    expect(snapshot.truncated).toBe(false);
  });

  it('最新まで受信済みなら空を返す', () => {
    const buffer = new OutputRingBuffer({ maxLines: 100 });
    buffer.push('one');
    const snapshot = buffer.snapshotSince(1);
    expect(snapshot.data).toBe('');
    expect(snapshot.seq).toBe(1);
  });

  it('表示行数の上限を超えると古いチャンクを破棄する', () => {
    const buffer = new OutputRingBuffer({ maxLines: 5 });
    for (let i = 0; i < 20; i += 1) {
      buffer.push(`line${i}\n`);
    }
    expect(buffer.lineCount).toBeLessThanOrEqual(5);
    expect(buffer.hasDropped).toBe(true);
    const snapshot = buffer.snapshot();
    expect(snapshot.data).toContain('line19');
    expect(snapshot.data).not.toContain('line0\n');
    expect(snapshot.truncated).toBe(true);
  });

  it('バイト数上限でも破棄する（改行を含まない出力）', () => {
    const buffer = new OutputRingBuffer({ maxLines: 1000, maxBytes: 100 });
    for (let i = 0; i < 20; i += 1) {
      buffer.push('x'.repeat(30));
    }
    expect(buffer.byteCount).toBeLessThanOrEqual(100);
    expect(buffer.hasDropped).toBe(true);
  });

  it('チャンク境界でのみ破棄するため、ANSIシーケンスが途中で切れない', () => {
    const esc = String.fromCharCode(0x1b);
    const buffer = new OutputRingBuffer({ maxLines: 2 });
    buffer.push(`${esc}[31mred${esc}[0m\n`);
    buffer.push(`${esc}[32mgreen${esc}[0m\n`);
    buffer.push(`${esc}[33myellow${esc}[0m\n`);
    const snapshot = buffer.snapshot();
    // 残っている各チャンクは開始と終了のエスケープを両方含む。
    const escapeCount = snapshot.data.split(esc).length - 1;
    expect(escapeCount % 2).toBe(0);
  });

  it('欠落がある場合は truncated=true で全内容を返す', () => {
    const buffer = new OutputRingBuffer({ maxLines: 2 });
    for (let i = 0; i < 10; i += 1) buffer.push(`l${i}\n`);
    const snapshot = buffer.snapshotSince(1);
    expect(snapshot.truncated).toBe(true);
  });

  it('不正な afterSeq を安全に扱う', () => {
    const buffer = new OutputRingBuffer({ maxLines: 10 });
    buffer.push('a');
    expect(buffer.snapshotSince(-5).data).toBe('a');
    expect(buffer.snapshotSince(Number.NaN).data).toBe('a');
    expect(buffer.snapshotSince(9999).data).toBe('');
  });

  it('直近1チャンクは上限を超えていても保持する', () => {
    const buffer = new OutputRingBuffer({ maxLines: 1, maxBytes: 10 });
    buffer.push('x'.repeat(1000));
    expect(buffer.chunkCount).toBe(1);
    expect(buffer.snapshot().data.length).toBe(1000);
  });

  it('clear で内容を破棄する', () => {
    const buffer = new OutputRingBuffer({ maxLines: 10 });
    buffer.push('secret');
    buffer.clear();
    expect(buffer.snapshot().data).toBe('');
  });

  it('maxLines が不正なら例外', () => {
    expect(() => new OutputRingBuffer({ maxLines: 0 })).toThrow();
  });
});
