/**
 * 出力リングバッファ。
 *
 * 設計方針（docs/DECISIONS.md D-002 に対応）:
 * PTY出力を「行」で切ると、ANSIエスケープシーケンスの途中で分断され、
 * 再接続時の描画が壊れる。そのためバッファはPTYから受け取ったチャンク単位で
 * 保持し、破棄もチャンク境界でのみ行う。表示行数の上限はチャンク内の改行数を
 * 数えて近似的に適用する。あわせて総バイト数の上限も設け、
 * 改行を含まない巨大出力でもメモリが無制限に増えないようにする。
 */

export interface Snapshot {
  /** 連結済みの生PTY出力。 */
  readonly data: string;
  /** このスナップショットの末尾シーケンス番号。 */
  readonly seq: number;
  /** バッファ上限により、要求範囲より古い出力が失われているか。 */
  readonly truncated: boolean;
}

interface Chunk {
  readonly seq: number;
  readonly data: string;
  readonly lines: number;
  readonly bytes: number;
}

export interface RingBufferOptions {
  /** 保持する最大表示行数。 */
  readonly maxLines: number;
  /** 保持する最大バイト数。既定は maxLines * 512（最小 1MiB、最大 64MiB）。 */
  readonly maxBytes?: number;
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

export class OutputRingBuffer {
  private readonly chunks: Chunk[] = [];
  private readonly maxLines: number;
  private readonly maxBytes: number;

  private totalLines = 0;
  private totalBytes = 0;
  private lastSeq = 0;
  /** 一度でも古いチャンクを破棄したか。 */
  private dropped = false;

  constructor(options: RingBufferOptions) {
    if (!Number.isSafeInteger(options.maxLines) || options.maxLines <= 0) {
      throw new Error('maxLines には正の整数を指定してください。');
    }
    this.maxLines = options.maxLines;
    this.maxBytes =
      options.maxBytes ??
      Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, options.maxLines * 512));
  }

  /** 現在の末尾シーケンス番号。 */
  get currentSeq(): number {
    return this.lastSeq;
  }

  /** 保持中のチャンク数（テスト・診断用）。 */
  get chunkCount(): number {
    return this.chunks.length;
  }

  /** 保持中の概算表示行数。 */
  get lineCount(): number {
    return this.totalLines;
  }

  get byteCount(): number {
    return this.totalBytes;
  }

  /** 古い出力が破棄されたことがあるか。 */
  get hasDropped(): boolean {
    return this.dropped;
  }

  /**
   * 出力チャンクを追加し、割り当てたシーケンス番号を返す。
   */
  push(data: string): number {
    if (data.length === 0) {
      return this.lastSeq;
    }
    this.lastSeq += 1;
    const chunk: Chunk = {
      seq: this.lastSeq,
      data,
      lines: countLines(data),
      bytes: Buffer.byteLength(data, 'utf8'),
    };
    this.chunks.push(chunk);
    this.totalLines += chunk.lines;
    this.totalBytes += chunk.bytes;
    this.trim();
    return chunk.seq;
  }

  private trim(): void {
    // 直近1チャンクは必ず残す（それ自体が上限を超えていても捨てない）。
    while (
      this.chunks.length > 1 &&
      (this.totalLines > this.maxLines || this.totalBytes > this.maxBytes)
    ) {
      const removed = this.chunks.shift() as Chunk;
      this.totalLines -= removed.lines;
      this.totalBytes -= removed.bytes;
      this.dropped = true;
    }
  }

  /**
   * afterSeq より後ろの出力を返す。
   *
   * - afterSeq が現在の末尾以上なら空データを返す。
   * - afterSeq より後ろの一部が既に破棄されている場合は、保持している全内容を
   *   truncated=true で返す（欠落を隠さない）。
   */
  snapshotSince(afterSeq: number): Snapshot {
    const safeAfter = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0;

    if (safeAfter >= this.lastSeq) {
      return { data: '', seq: this.lastSeq, truncated: false };
    }

    const oldest = this.chunks[0];
    if (oldest === undefined) {
      return { data: '', seq: this.lastSeq, truncated: false };
    }

    // 要求された次のシーケンス番号が、保持している最古チャンクより前なら欠落あり。
    const gap = safeAfter + 1 < oldest.seq;

    const parts: string[] = [];
    for (const chunk of this.chunks) {
      if (chunk.seq > safeAfter) parts.push(chunk.data);
    }

    return {
      data: parts.join(''),
      seq: this.lastSeq,
      truncated: gap || (safeAfter === 0 && this.dropped),
    };
  }

  /** 全内容を返す（新規接続用）。 */
  snapshot(): Snapshot {
    return this.snapshotSince(0);
  }

  /** 内容を破棄する。終了処理でメモリ上の出力を残さないために使う。 */
  clear(): void {
    this.chunks.length = 0;
    this.totalLines = 0;
    this.totalBytes = 0;
  }
}
