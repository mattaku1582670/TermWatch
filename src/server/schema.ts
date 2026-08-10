import {
  MAX_TEXT_INPUT_BYTES,
  SPECIAL_KEYS,
  type ClientMessage,
  type SpecialKey,
} from '../shared/protocol.js';

/**
 * WebSocketで受け取ったクライアントメッセージのスキーマ検証。
 *
 * 外部依存を増やさないため手書きの検証を行う。
 * 未知のtype、想定外の型、上限超過はすべて拒否する（許可リスト方式）。
 */

export type ValidationResult =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: 'invalid-message' | 'too-large'; readonly reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSpecialKey(value: unknown): value is SpecialKey {
  return typeof value === 'string' && (SPECIAL_KEYS as readonly string[]).includes(value);
}

/**
 * 生のテキストフレームを検証済みClientMessageへ変換する。
 */
export function parseClientMessage(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'invalid-message', reason: 'JSONとして解釈できません。' };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, code: 'invalid-message', reason: 'オブジェクトではありません。' };
  }

  const type = parsed['type'];
  if (typeof type !== 'string') {
    return { ok: false, code: 'invalid-message', reason: 'typeがありません。' };
  }

  switch (type) {
    case 'ping':
      return { ok: true, message: { type: 'ping' } };

    case 'control.request':
      return { ok: true, message: { type: 'control.request' } };

    case 'control.release':
      return { ok: true, message: { type: 'control.release' } };

    case 'resume': {
      const lastSeq = parsed['lastSeq'];
      if (typeof lastSeq !== 'number' || !Number.isSafeInteger(lastSeq) || lastSeq < 0) {
        return { ok: false, code: 'invalid-message', reason: 'lastSeqが不正です。' };
      }
      const handle = parsed['controlHandle'];
      if (handle !== null && handle !== undefined && typeof handle !== 'string') {
        return { ok: false, code: 'invalid-message', reason: 'controlHandleが不正です。' };
      }
      if (typeof handle === 'string' && handle.length > 256) {
        return { ok: false, code: 'invalid-message', reason: 'controlHandleが長すぎます。' };
      }
      return {
        ok: true,
        message: { type: 'resume', lastSeq, controlHandle: typeof handle === 'string' ? handle : null },
      };
    }

    case 'input.key': {
      const key = parsed['key'];
      if (!isSpecialKey(key)) {
        return { ok: false, code: 'invalid-message', reason: 'keyが許可された値ではありません。' };
      }
      return { ok: true, message: { type: 'input.key', key } };
    }

    case 'input.text': {
      const text = parsed['text'];
      const submit = parsed['submit'];
      if (typeof text !== 'string') {
        return { ok: false, code: 'invalid-message', reason: 'textが文字列ではありません。' };
      }
      if (typeof submit !== 'boolean') {
        return { ok: false, code: 'invalid-message', reason: 'submitが真偽値ではありません。' };
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_INPUT_BYTES) {
        return {
          ok: false,
          code: 'too-large',
          reason: `1回のテキスト入力は${MAX_TEXT_INPUT_BYTES}バイトまでです。`,
        };
      }
      return { ok: true, message: { type: 'input.text', text, submit } };
    }

    default:
      return { ok: false, code: 'invalid-message', reason: '未知のtypeです。' };
  }
}
