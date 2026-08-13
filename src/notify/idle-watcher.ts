/**
 * 子プロセスの出力が止まったことの検知。
 *
 * 出力のたびにタイマーを張り直し、しきい値に達したら1度だけ知らせる。
 * 出力が再開するまで再通知しないのは、誤報を増やさないため
 * （通知の唯一の欠点が誤報である）。
 *
 * UI の「出力停止中」判定（IDLE_THRESHOLD_MS = 3秒）とは別物。
 * 3秒は入力を考えている間にも成立するため、通知には短すぎる。
 */

export interface IdleWatcherOptions {
  /** この時間だけ出力が無ければ知らせる。 */
  readonly idleMs: number;
  readonly onIdle: () => void;
}

export class IdleWatcher {
  private timer: NodeJS.Timeout | null = null;
  /** 今の静止期間で既に知らせたか。 */
  private fired = false;
  private stopped = false;

  constructor(private readonly options: IdleWatcherOptions) {}

  /** 出力があったことを伝える。 */
  noteOutput(): void {
    if (this.stopped) return;
    this.fired = false;
    this.arm();
  }

  /** 監視を終える。多重呼び出し安全。 */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private arm(): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.fired) return;
      this.fired = true;
      this.options.onIdle();
    }, this.options.idleMs);
    // 通知のためだけにプロセスを生かし続けない。
    this.timer.unref?.();
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
