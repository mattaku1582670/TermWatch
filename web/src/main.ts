import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Connection, type ConnectionState } from './connection';
import { buildConnectionClass, buildConnectionLabel } from './connection-label';
import {
  caretIndexAfter,
  formatPairingInput,
  normalizePairingCode,
} from '../../src/shared/pairing';
import type {
  ControlStatus,
  ServerMessage,
  SpecialKey,
  StatusPayload,
} from '../../src/shared/protocol';

/**
 * TermWatch スマートフォンWeb UI。
 *
 * - ターミナル文字列は必ず xterm.js へデータとして渡す（HTMLとして挿入しない）。
 * - 既定は閲覧モード。操作モードは確認を経て明示的に有効化する。
 * - サーバー側でも操作権を検査するため、UI側の制限は利便性のためのもの。
 */

/* ------------------------------------------------------------------ */
/* 要素取得                                                            */
/* ------------------------------------------------------------------ */

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`要素が見つかりません: ${id}`);
  return found as T;
}

const pairingSection = el<HTMLElement>('pairing');
const pairingForm = el<HTMLFormElement>('pairing-form');
const pairingInput = el<HTMLInputElement>('pairing-input');
const pairingSubmit = el<HTMLButtonElement>('pairing-submit');
const pairingError = el<HTMLElement>('pairing-error');

const appSection = el<HTMLElement>('app');
const commandName = el<HTMLElement>('command-name');
const modeBadge = el<HTMLElement>('mode-badge');
const connState = el<HTMLElement>('conn-state');
const procState = el<HTMLElement>('proc-state');
const idleTime = el<HTMLElement>('idle-time');
const controlRemaining = el<HTMLElement>('control-remaining');
const terminalHost = el<HTMLElement>('terminal');
const jumpLatest = el<HTMLButtonElement>('jump-latest');
const notice = el<HTMLElement>('notice');
const keybar = el<HTMLElement>('keybar');
const textInput = el<HTMLTextAreaElement>('text-input');
const sendButton = el<HTMLButtonElement>('send-button');
const controlToggle = el<HTMLButtonElement>('control-toggle');

const confirmBackdrop = el<HTMLElement>('confirm');
const confirmBody = el<HTMLElement>('confirm-body');
const confirmOk = el<HTMLButtonElement>('confirm-ok');
const confirmCancel = el<HTMLButtonElement>('confirm-cancel');

/* ------------------------------------------------------------------ */
/* 状態                                                                */
/* ------------------------------------------------------------------ */

let control: ControlStatus = { held: false, mine: false, expiresAt: null };
let status: StatusPayload | null = null;
let connectionState: ConnectionState = 'connecting';
/**
 * 再接続を試み始めた時刻。接続できている間は null。
 *
 * 再接続は無期限に続けるため、表示だけでは瞬断と長期切断を区別できない。
 * 経過時間を併記して、待つべきか PC 側を見に行くべきかを判断できるようにする。
 */
let reconnectingSince: number | null = null;
/** 一度でも接続できたか。初回接続と再接続を区別する。 */
let hasConnected = false;
/** 現在のブラウザセッション内だけに保持する送信履歴。 */
const sendHistory: string[] = [];

/* ------------------------------------------------------------------ */
/* ターミナル                                                          */
/* ------------------------------------------------------------------ */

const terminal = new Terminal({
  convertEol: false,
  cursorBlink: false,
  disableStdin: true,
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  scrollback: 10000,
  allowProposedApi: false,
  theme: {
    background: '#000000',
    foreground: '#e6edf3',
    cursor: '#e6edf3',
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);

function fitTerminal(): void {
  try {
    fitAddon.fit();
  } catch {
    // レイアウト未確定時は無視する。
  }
}

/* ------------------------------------------------------------------ */
/* 確認ダイアログ                                                      */
/* ------------------------------------------------------------------ */

let confirmResolve: ((ok: boolean) => void) | null = null;

function askConfirm(message: string, okLabel: string): Promise<boolean> {
  confirmBody.textContent = message;
  confirmOk.textContent = okLabel;
  confirmBackdrop.hidden = false;
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
  });
}

function closeConfirm(result: boolean): void {
  confirmBackdrop.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(result);
}

confirmOk.addEventListener('click', () => closeConfirm(true));
confirmCancel.addEventListener('click', () => closeConfirm(false));
confirmBackdrop.addEventListener('click', (event) => {
  if (event.target === confirmBackdrop) closeConfirm(false);
});

/* ------------------------------------------------------------------ */
/* 表示更新                                                            */
/* ------------------------------------------------------------------ */

const PROCESS_LABELS: Record<string, string> = {
  starting: '起動中',
  running: '実行中',
  idle: '出力停止中',
  exited: '終了',
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}秒`;
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

function setNotice(text: string, level: 'info' | 'warn' | 'danger' = 'info'): void {
  if (text === '') {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }
  notice.hidden = false;
  notice.textContent = text;
  notice.className = level === 'info' ? 'notice' : `notice ${level}`;
}

function renderHeader(): void {
  connState.textContent = buildConnectionLabel(connectionState, reconnectingSince, Date.now());
  connState.className = buildConnectionClass(connectionState, reconnectingSince, Date.now());

  if (status === null) {
    procState.textContent = '-';
    idleTime.textContent = '';
  } else {
    const label = PROCESS_LABELS[status.process] ?? status.process;
    if (status.process === 'exited') {
      procState.textContent = `終了（終了コード ${status.exitCode ?? '不明'}）`;
      procState.className = 'meta danger';
    } else {
      procState.textContent = label;
      procState.className = status.process === 'idle' ? 'meta warn' : 'meta ok';
    }

    if (status.lastOutputAt === null) {
      idleTime.textContent = '';
    } else {
      idleTime.textContent = `最終出力 ${formatDuration(Date.now() - status.lastOutputAt)}前`;
    }
  }

  if (control.mine && control.expiresAt !== null) {
    const remaining = control.expiresAt - Date.now();
    controlRemaining.textContent = `操作モード 残り${formatDuration(remaining)}`;
    controlRemaining.className = remaining <= 60_000 ? 'meta danger' : 'meta ok';
  } else if (control.held) {
    controlRemaining.textContent = '他の端末が操作中';
    controlRemaining.className = 'meta warn';
  } else {
    controlRemaining.textContent = '';
    controlRemaining.className = 'meta';
  }

  const canControl = control.mine;
  modeBadge.textContent = canControl ? '操作モード' : '閲覧モード';
  modeBadge.className = canControl ? 'badge badge-control' : 'badge badge-view';
  controlToggle.textContent = canControl ? '閲覧モードに戻す' : '操作モードにする';

  const exited = status?.process === 'exited';
  textInput.disabled = !canControl || exited;
  sendButton.disabled = !canControl || exited;
  textInput.placeholder = canControl
    ? '指示を入力（複数行可）。送信すると最後にEnterを送ります。'
    : '操作モードを有効にすると入力できます';
  controlToggle.disabled = exited && !canControl;

  for (const button of keybar.querySelectorAll('button')) {
    (button as HTMLButtonElement).disabled = !canControl || exited;
  }
}

/** 1秒ごとに経過時間表示を更新する。 */
window.setInterval(renderHeader, 1000);

/* ------------------------------------------------------------------ */
/* スクロール制御                                                      */
/* ------------------------------------------------------------------ */

let stickToBottom = true;

terminal.onScroll(() => {
  const viewport = terminal.buffer.active.viewportY;
  const baseY = terminal.buffer.active.baseY;
  stickToBottom = baseY - viewport <= 1;
  jumpLatest.hidden = stickToBottom;
});

jumpLatest.addEventListener('click', () => {
  terminal.scrollToBottom();
  stickToBottom = true;
  jumpLatest.hidden = true;
});

function writeOutput(data: string): void {
  terminal.write(data, () => {
    if (stickToBottom) terminal.scrollToBottom();
  });
}

/* ------------------------------------------------------------------ */
/* 接続                                                                */
/* ------------------------------------------------------------------ */

const connection = new Connection({
  onStateChange: (state) => {
    connectionState = state;
    // 一度でも接続できた後の切断サイクルなら、経過時間を数え続ける。
    // 画面復帰による即時再試行は backoff を初期化して 'connecting' を通すため、
    // 状態名だけで判定すると経過時間がリセットされてしまう（D-027）。
    if (state === 'open' || state === 'unauthorized' || state === 'closed') {
      reconnectingSince = null;
      if (state === 'open') hasConnected = true;
    } else if (hasConnected) {
      reconnectingSince ??= Date.now();
    }
    if (state === 'unauthorized') {
      showPairing('接続が切れました。ペアリングコードを入力し直してください。');
    }
    renderHeader();
  },
  onMessage: (message) => {
    handleServerMessage(message);
  },
});

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'hello':
      commandName.textContent = message.session.command;
      document.title = `TermWatch: ${message.session.command}`;
      break;

    case 'snapshot':
      terminal.reset();
      if (message.truncated) {
        setNotice('バッファ上限のため、これより古い出力は破棄されています。', 'warn');
      }
      writeOutput(message.data);
      connection.lastSeq = message.seq;
      terminal.scrollToBottom();
      stickToBottom = true;
      jumpLatest.hidden = true;
      break;

    case 'output':
      writeOutput(message.data);
      connection.lastSeq = message.seq;
      break;

    case 'status':
      status = message.status;
      control = message.status.control;
      connection.controlHandle = control.mine ? (control.handle ?? connection.controlHandle) : null;
      renderHeader();
      break;

    case 'control':
      control = message.control;
      connection.controlHandle = control.mine ? (control.handle ?? null) : null;
      applyControlReason(message.reason);
      renderHeader();
      break;

    case 'error':
      handleServerError(message.code, message.message);
      break;

    default:
      break;
  }
}

function applyControlReason(reason: string): void {
  switch (reason) {
    case 'granted':
      setNotice('操作モードを有効にしました。時間切れで自動的に閲覧モードへ戻ります。');
      break;
    case 'released':
      setNotice('操作モードを解除しました。');
      break;
    case 'expired':
      setNotice('操作モードの有効時間が終了しました。閲覧モードへ戻ります。', 'warn');
      break;
    case 'disconnected':
      setNotice('切断が続いたため操作権が解除されました。', 'warn');
      break;
    case 'denied-busy':
      setNotice('他の端末が操作モード中のため、操作権を取得できません。', 'warn');
      break;
    case 'process-exited':
      setNotice('子プロセスが終了したため操作モードを解除しました。', 'warn');
      break;
    default:
      break;
  }
}

function handleServerError(code: string, message: string): void {
  if (code === 'unauthorized') {
    showPairing('認証が必要です。ペアリングコードを入力してください。');
    return;
  }
  setNotice(message, code === 'forbidden' ? 'warn' : 'danger');
}

/* ------------------------------------------------------------------ */
/* 入力操作                                                            */
/* ------------------------------------------------------------------ */

controlToggle.addEventListener('click', () => {
  void (async (): Promise<void> => {
    if (control.mine) {
      connection.send({ type: 'control.release' });
      return;
    }
    const ok = await askConfirm(
      'この端末からPTYへ入力できるようになります。誤操作に注意してください。操作モードを有効にしますか？',
      '有効にする',
    );
    if (!ok) return;
    connection.send({ type: 'control.request' });
  })();
});

keybar.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const key = target.dataset['key'] as SpecialKey | undefined;
  if (key === undefined) return;

  if (key === 'ctrl-c') {
    void (async (): Promise<void> => {
      const ok = await askConfirm(
        'Ctrl+C を送信すると、実行中の処理が中断されたり子プロセスが終了したりする場合があります。送信しますか？',
        'Ctrl+C を送る',
      );
      if (ok) connection.send({ type: 'input.key', key });
    })();
    return;
  }
  connection.send({ type: 'input.key', key });
});

function submitText(): void {
  const text = textInput.value;
  if (text.length === 0) return;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > 64 * 1024) {
    setNotice('1回に送信できるテキストは64KiBまでです。', 'danger');
    return;
  }
  if (!connection.send({ type: 'input.text', text, submit: true })) {
    setNotice('接続されていないため送信できません。', 'danger');
    return;
  }
  sendHistory.push(text);
  textInput.value = '';
  setNotice('');
}

sendButton.addEventListener('click', submitText);

// テキストエリア内のEnterは改行として扱い、誤送信を防ぐ。
// 送信は「送信」ボタンのみで行う。

/* ------------------------------------------------------------------ */
/* ペアリング                                                          */
/* ------------------------------------------------------------------ */

function showPairing(message: string): void {
  connection.stop();
  appSection.hidden = true;
  pairingSection.hidden = false;
  pairingError.hidden = message === '';
  pairingError.textContent = message;
  pairingInput.value = '';
  lastPairingValue = '';
  pairingInput.focus();
}

function showApp(): void {
  pairingSection.hidden = true;
  appSection.hidden = false;
  if (terminal.element === undefined) {
    terminal.open(terminalHost);
  }
  fitTerminal();
  connection.start();

  // 登録済みなら押せないようにする。
  void navigator.serviceWorker?.getRegistration().then(async (registration) => {
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription !== null && subscription !== undefined) markNotifyEnabled();
  });
}

/**
 * ペアリングコード入力欄の整形。
 *
 * ハイフンは照合時に無視されるため入力不要だが、PC側の表示が `ABCD-EFGH` なので、
 * 見比べながら打てるよう自動で挿入する。小文字と文字集合外の文字もここで吸収する。
 *
 * 区切りを消そうとしたときは、その手前の1文字も一緒に消す。
 * そうしないと再挿入されて、消せないように見えてしまう。
 */
let lastPairingValue = '';
pairingInput.addEventListener('input', (event) => {
  const inputEvent = event as InputEvent;
  // IME変換中は書き換えない。未確定文字列が消えたり変換が中断されたりする。
  if (inputEvent.isComposing) return;

  const raw = pairingInput.value;
  const caret = pairingInput.selectionStart ?? raw.length;
  const inputType = inputEvent.inputType ?? '';

  // カーソルより前にあるコード文字の数。整形で文字数が変わるため、
  // 位置ではなく個数で数え直す。
  let count = normalizePairingCode(raw.slice(0, caret)).length;
  let source = raw;

  // 区切りだけが消えた場合は、利用者が消したかった文字を代わりに消す。
  // そうしないと即座に再挿入され、消せないように見える。
  const codeChars = normalizePairingCode(raw);
  if (normalizePairingCode(lastPairingValue) === codeChars) {
    if (inputType === 'deleteContentBackward' && count > 0) {
      source = codeChars.slice(0, count - 1) + codeChars.slice(count);
      count -= 1;
    } else if (inputType === 'deleteContentForward' && count < codeChars.length) {
      source = codeChars.slice(0, count) + codeChars.slice(count + 1);
    }
  }

  const formatted = formatPairingInput(source);
  pairingInput.value = formatted;
  lastPairingValue = formatted;
  const position = caretIndexAfter(formatted, count);
  pairingInput.setSelectionRange(position, position);
});

// 変換確定時にまとめて整形する。変換中は上で何もしていないため、ここで揃える。
pairingInput.addEventListener('compositionend', () => {
  const formatted = formatPairingInput(pairingInput.value);
  pairingInput.value = formatted;
  lastPairingValue = formatted;
  pairingInput.setSelectionRange(formatted.length, formatted.length);
});

pairingForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async (): Promise<void> => {
    const code = pairingInput.value.trim();
    if (code.length === 0) return;
    pairingSubmit.disabled = true;
    pairingError.hidden = true;
    try {
      const response = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code }),
      });
      if (response.ok) {
        showApp();
        return;
      }
      if (response.status === 429) {
        pairingError.textContent =
          '試行回数が多すぎます。しばらく待ってからもう一度お試しください。';
      } else {
        pairingError.textContent = 'ペアリングコードが正しくないか、期限切れです。';
      }
      pairingError.hidden = false;
    } catch {
      pairingError.hidden = false;
      pairingError.textContent = 'PCへ接続できません。TermWatchが起動しているか確認してください。';
    } finally {
      pairingSubmit.disabled = false;
    }
  })();
});

/* ------------------------------------------------------------------ */
/* レイアウト・ライフサイクル                                          */
/* ------------------------------------------------------------------ */

/**
 * iOSのソフトウェアキーボード表示に合わせて高さを調整し、
 * 入力欄とターミナルの現在行が隠れないようにする。
 */
function syncViewportHeight(): void {
  const viewport = window.visualViewport;
  const height = viewport === undefined || viewport === null ? window.innerHeight : viewport.height;
  const root = document.documentElement;
  root.style.setProperty('--app-height', `${Math.round(height)}px`);

  // キーボード表示時、iOS はビジュアルビューポートを縮めたうえで上へずらす。
  // ずれた分だけアプリ本体を下げて、見えている領域にぴったり重ねる。
  // offsetTop と (pageTop - scrollY) はどちらもレイアウトビューポートからの
  // ずれを表すため、足すと約2倍ずれる。offsetTop だけを使う（D-026）。
  const offset = viewport?.offsetTop ?? 0;
  root.style.setProperty('--app-offset', `${Math.round(Math.max(0, offset))}px`);

  // キーボードが出ているかを高さの差から推定し、下端の余白を切り替える。
  const keyboardOpen = window.innerHeight - height > 120;
  appSection.classList.toggle('keyboard-open', keyboardOpen);

  fitTerminal();
  if (stickToBottom) terminal.scrollToBottom();
}

window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('scroll', syncViewportHeight);
window.addEventListener('resize', syncViewportHeight);
window.addEventListener('orientationchange', () => window.setTimeout(syncViewportHeight, 200));

textInput.addEventListener('focus', () => {
  window.setTimeout(syncViewportHeight, 250);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    connection.reconnectNow();
    syncViewportHeight();
  }
});

/* ------------------------------------------------------------------ */
/* 起動                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 通知                                                                */
/* ------------------------------------------------------------------ */

const notifyToggle = el<HTMLButtonElement>('notify-toggle');

/** base64url の VAPID 公開鍵を Uint8Array へ直す。 */
function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function markNotifyEnabled(): void {
  notifyToggle.textContent = '通知は有効です';
  notifyToggle.disabled = true;
}

async function enableNotifications(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    setNotice('この端末では通知を使えません。ホーム画面へ追加してから開いてください。', 'warn');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    setNotice('通知が許可されませんでした。', 'warn');
    return;
  }

  const registration = await navigator.serviceWorker.register('./sw.js');
  const keyResponse = await fetch('/api/push/key', { credentials: 'same-origin' });
  if (!keyResponse.ok) {
    setNotice('通知の設定を取得できませんでした。', 'warn');
    return;
  }
  const { publicKey } = (await keyResponse.json()) as { publicKey: string };

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(publicKey) as BufferSource,
  });

  const saved = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!saved.ok) {
    setNotice('通知の登録に失敗しました。', 'warn');
    return;
  }

  markNotifyEnabled();
  setNotice('通知を有効にしました。出力が止まるとお知らせします。');
}

notifyToggle.addEventListener('click', () => {
  void enableNotifications().catch(() => {
    setNotice('通知を有効にできませんでした。', 'warn');
  });
});

async function bootstrap(): Promise<void> {
  syncViewportHeight();
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    const body: unknown = await response.json();
    const authorized =
      typeof body === 'object' && body !== null && (body as Record<string, unknown>)['authorized'];
    if (authorized === true) {
      showApp();
      return;
    }
  } catch {
    // 認証状態を確認できない場合はペアリング画面を出す。
  }
  showPairing('');
}

void bootstrap();
