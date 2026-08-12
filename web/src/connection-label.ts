/**
 * 接続状態の型と表示文言。
 *
 * この モジュールは DOM に依存させない。connection.ts は WebSocket や window を
 * 使うため、単体テストから読み込むと DOM 型が必要になってしまう。
 * 型もここに置き、connection.ts 側から再輸出する。
 */
export type ConnectionState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'unauthorized'
  | 'closed';

/**
 * 接続状態の表示文言。
 *
 * 再接続は無期限に続けるため（瞬断やスリープ復帰で勝手に諦めると
 * その都度リロードが必要になる）、「再接続中」のままでは
 * 数秒の瞬断なのか転送が失われたのかを利用者が区別できない。
 * 経過時間を併記して判断材料にする。
 */

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: '接続中…',
  open: '接続済み',
  reconnecting: '再接続中',
  unauthorized: '認証切れ',
  closed: 'PC未接続',
};

/** この時間を超えて再接続できなければ警告色にする。 */
export const RECONNECT_WARN_MS = 30_000;

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}秒`;
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

/**
 * 再接続を試みている最中か。
 *
 * 画面復帰による即時再試行は backoff を初期化するため `connecting` を通る。
 * 状態名だけで区別すると経過時間の表示が途切れる。
 */
function isRetrying(state: ConnectionState): boolean {
  return state === 'reconnecting' || state === 'connecting';
}

export function buildConnectionLabel(
  state: ConnectionState,
  reconnectingSince: number | null,
  now: number,
): string {
  const label = CONNECTION_LABELS[state] ?? state;
  if (!isRetrying(state) || reconnectingSince === null) return label;
  return `${label}（${formatDuration(now - reconnectingSince)}）`;
}

export function buildConnectionClass(
  state: ConnectionState,
  reconnectingSince: number | null,
  now: number,
): string {
  if (state === 'open') return 'meta ok';
  if (
    isRetrying(state) &&
    reconnectingSince !== null &&
    now - reconnectingSince >= RECONNECT_WARN_MS
  ) {
    return 'meta danger';
  }
  return 'meta warn';
}
