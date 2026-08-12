import { appendFileSync, closeSync, openSync, writeSync } from 'node:fs';

/**
 * 入力経路の診断記録（既定では無効）。
 *
 * 環境変数 TERMWATCH_DEBUG_INPUT にファイルパスを指定したときだけ有効になる。
 * 不具合の再現待ちのための一時的な計測であり、通常運用では動作しない。
 *
 * 記録範囲は PTY へ渡る入力すべて。PC側のキー入力に加えて、
 * スマートフォンから送られた本文も平文で残る。子プロセスへ打ち込んだ
 * API キーやパスワードも対象になるため、有効化は調査中のみに限る
 * （起動時に警告を表示する）。
 */

const ENV_KEY = 'TERMWATCH_DEBUG_INPUT';

let target: string | null = null;
let started = 0;

/** 診断記録が有効なら保存先を返す。 */
export function inputTracePath(): string | null {
  return target;
}

export function initInputTrace(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[ENV_KEY];
  if (typeof value !== 'string' || value.trim().length === 0) {
    target = null;
    return null;
  }
  target = value.trim();
  started = Date.now();
  try {
    // 記録には子プロセスへ打ち込んだ資格情報が混ざり得る。
    // 新規作成時の権限を所有者のみに絞る（既存ファイルの権限は変えない）。
    const handle = openSync(target, 'a', 0o600);
    try {
      writeSync(handle, `--- TermWatch 入力診断 開始 ${new Date().toISOString()} ---\n`);
    } finally {
      closeSync(handle);
    }
  } catch {
    target = null;
  }
  return target;
}

/** 制御文字を読める形へ直す（ESC は <ESC> と表記）。 */
export function describeBytes(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x1b) out += '<ESC>';
    else if (code === 0x0d) out += '<CR>';
    else if (code === 0x0a) out += '<LF>';
    else if (code < 0x20 || code === 0x7f) out += `<${code.toString(16).padStart(2, '0')}>`;
    else out += ch;
  }
  return out;
}

/** 1件記録する。無効時は何もしない。 */
export function traceInput(label: string, text: string): void {
  if (target === null) return;
  const at = (Date.now() - started).toString().padStart(7, ' ');
  try {
    appendFileSync(target, `${at}ms ${label} len=${text.length} ${describeBytes(text)}\n`, 'utf8');
  } catch {
    // 記録の失敗で本体を止めない。
    target = null;
  }
}
