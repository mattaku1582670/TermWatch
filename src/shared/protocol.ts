/**
 * TermWatch WebSocket プロトコル定義。
 *
 * サーバー（Node.js）とWeb UI（ブラウザ）の両方から参照する。
 * Node固有・ブラウザ固有のAPIをこのファイルへ持ち込まないこと。
 */

/** 1回のテキスト入力の上限（バイト、UTF-8換算）。 */
export const MAX_TEXT_INPUT_BYTES = 64 * 1024;

/** WebSocketフレーム全体の上限。テキスト上限＋JSONエンベロープの余裕分。 */
export const MAX_WS_MESSAGE_BYTES = MAX_TEXT_INPUT_BYTES + 4 * 1024;

/** 「出力停止中」と判定するまでの無出力時間（ミリ秒）。 */
export const IDLE_THRESHOLD_MS = 3000;

/** 操作権の残り時間警告しきい値（ミリ秒）。 */
export const CONTROL_WARNING_MS = 60 * 1000;

/** 切断が継続したとき操作権を解除するまでの時間（ミリ秒）。 */
export const CONTROL_DISCONNECT_GRACE_MS = 60 * 1000;

/** 観測可能なプロセス状態。出力内容の意味解析は行わない。 */
export type ProcessState = 'starting' | 'running' | 'idle' | 'exited';

/** クライアントの権限モード。 */
export type ClientMode = 'view' | 'control';

/** 送信可能な特殊キー。 */
export const SPECIAL_KEYS = [
  'enter',
  'escape',
  'tab',
  'ctrl-c',
  'up',
  'down',
  'left',
  'right',
  'y',
  'n',
] as const;

export type SpecialKey = (typeof SPECIAL_KEYS)[number];

/** 特殊キー → PTYへ書き込むバイト列（ANSI）。 */
export const SPECIAL_KEY_SEQUENCES: Readonly<Record<SpecialKey, string>> = Object.freeze({
  enter: '\r',
  escape: '\u001b',
  tab: '\t',
  'ctrl-c': '\u0003',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  y: 'y',
  n: 'n',
});

/* ------------------------------------------------------------------ */
/* サーバー → クライアント                                              */
/* ------------------------------------------------------------------ */

export interface SessionInfo {
  /** 実行中のコマンド表示名（引数含む、表示用）。 */
  readonly command: string;
  /** TermWatchのバージョン。 */
  readonly version: string;
  /** 操作権の既定有効時間（ミリ秒）。 */
  readonly controlDurationMs: number;
  /** 保持している最大表示行数。 */
  readonly bufferLines: number;
}

export interface ControlStatus {
  /** 誰かが操作権を保持しているか。 */
  readonly held: boolean;
  /** このクライアント自身が保持しているか。 */
  readonly mine: boolean;
  /** 自分が保持している場合の失効時刻（epochミリ秒）。保持していなければnull。 */
  readonly expiresAt: number | null;
  /**
   * 自分が保持している場合の再接続用ハンドル。保持していなければnull。
   * 所有クライアントにだけ送る秘密値で、ログ・URLへ出さない。
   */
  readonly handle?: string | null;
}

export interface StatusPayload {
  readonly process: ProcessState;
  /** 子プロセスの終了コード（未終了ならnull）。 */
  readonly exitCode: number | null;
  /** 終了シグナル（該当なしならnull）。 */
  readonly exitSignal: number | null;
  /** 最終出力時刻（epochミリ秒）。まだ出力がなければnull。 */
  readonly lastOutputAt: number | null;
  readonly control: ControlStatus;
  /** 接続中のリモートクライアント数。 */
  readonly viewers: number;
}

export type ServerMessage =
  /** 認証完了。以後 snapshot / output / status を配信する。 */
  | { readonly type: 'hello'; readonly session: SessionInfo; readonly mode: ClientMode }
  /** 再接続用スナップショット。data は生PTY出力の連結。 */
  | {
      readonly type: 'snapshot';
      readonly data: string;
      /** このスナップショットに含まれる最後のシーケンス番号。 */
      readonly seq: number;
      /** バッファ上限により古い出力が破棄されているか。 */
      readonly truncated: boolean;
    }
  /** ライブ出力。seq は単調増加。 */
  | { readonly type: 'output'; readonly data: string; readonly seq: number }
  | { readonly type: 'status'; readonly status: StatusPayload }
  /** 操作権の変化通知。 */
  | { readonly type: 'control'; readonly control: ControlStatus; readonly reason: ControlReason }
  /** 回復可能なエラー通知。詳細な内部情報は含めない。 */
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string };

export type ControlReason =
  | 'granted'
  | 'released'
  | 'expired'
  | 'taken-by-other'
  | 'disconnected'
  | 'process-exited'
  | 'denied-busy'
  | 'sync';

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid-message'
  | 'too-large'
  | 'rate-limited'
  | 'process-exited'
  | 'internal';

/* ------------------------------------------------------------------ */
/* クライアント → サーバー                                              */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  /**
   * 再接続時、既に受信済みのシーケンス番号を伝える。
   * controlHandle を添えると、60秒以内の再接続で操作権を引き継げる。
   */
  | { readonly type: 'resume'; readonly lastSeq: number; readonly controlHandle: string | null }
  /** 操作権の取得要求。 */
  | { readonly type: 'control.request' }
  /** 操作権の自主解除。 */
  | { readonly type: 'control.release' }
  /** テキスト送信。submit=true なら末尾でEnterを送る。 */
  | { readonly type: 'input.text'; readonly text: string; readonly submit: boolean }
  /** 特殊キー送信。 */
  | { readonly type: 'input.key'; readonly key: SpecialKey }
  /** 生存確認。 */
  | { readonly type: 'ping' };
