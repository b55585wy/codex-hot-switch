import type { SignedFleetStore } from '../model';
import type { FleetRuntime } from '../runtime';
import { RelayClientError, RelayUnknownMutationError, type FleetRelayClient } from './client';

export interface RelayWorkerOptions {
  client: FleetRelayClient;
  runtime: FleetRuntime;
  store: SignedFleetStore;
  migrate: (nodeId: string) => Promise<void>;
  onError?: (error: unknown) => void;
  /** Bounded reconnect backoff for a transient initial outage. */
  maxBackoffMs?: number;
}

function retryable(error: unknown): boolean {
  if (error instanceof RelayClientError) return !error.terminal;
  // Unknown mutation outcomes are the only result of a lost socket. Retrying
  // startup only re-reads/republishes metadata; it never replays a mutation.
  if (error instanceof RelayUnknownMutationError) return true;
  if (error instanceof Error) {
    if (/中继认证|身份|协议版本|签名|来源校验|归属|未初始化|另一台电脑|配置/.test(error.message)) return false;
  }
  return true;
}

/**
 * Owns the single worker startup loop. A transient initial relay outage leaves
 * the daemon alive in reconnect-pending state.
 *
 * The runtime owns the activation window: it validates home, migrates, publishes
 * and syncs projects, then invokes the readiness callback to activate the socket
 * before the first command drain. The same callback is retained for reconnect,
 * so a replacement socket is republished/synced and activated before draining.
 * A worker never activates or starts the runtime after stop.
 */
export class RelayWorker {
  private runtimeStarted = false;
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private startResult?: Promise<void>;

  constructor(private readonly options: RelayWorkerOptions) {
    // Caller-managed activation: reconnect emits `reconnected` while INACTIVE
    // and the runtime's retained callback performs activate before any drain.
    this.options.client.manageActivation();
  }

  start(): Promise<void> {
    if (this.startResult) return this.startResult;
    this.startResult = this.attemptStartup();
    return this.startResult;
  }

  private async attemptStartup(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.options.client.isReady) await this.options.client.connect();
      if (this.stopped) return;
      await this.startRuntimeOnce();
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof RelayClientError && error.terminal) throw error;
      if (!retryable(error)) throw error;
      this.scheduleRetry();
      return;
    }
    this.attempt = 0;
  }

  private async startRuntimeOnce(): Promise<void> {
    if (this.runtimeStarted || this.stopped) return;
    const { runtime, client } = this.options;
    // Runtime order: home + migrate + publish + syncProjects validate the local
    // authoritative state, then this callback activates, then command drain.
    await runtime.start(async () => {
      if (this.stopped) throw new RelayClientError('中继 worker 已停止', true, 'closed');
      await client.activate();
      if (this.stopped) throw new RelayClientError('中继 worker 已停止', true, 'closed');
    });
    if (this.stopped) return;
    this.runtimeStarted = true;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    if (this.options.client.fatalError) {
      this.options.onError?.(this.options.client.fatalError);
      return;
    }
    const max = this.options.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, Math.floor(500 * 2 ** Math.min(this.attempt, 6)))
      + Math.floor(Math.random() * 250);
    this.attempt += 1;
    const timer = setTimeout(() => {
      if (this.retryTimer === timer) this.retryTimer = undefined;
      if (this.stopped) return;
      void this.attemptStartup()
        .catch(error => {
          if (this.stopped) return;
          if (error instanceof RelayClientError && error.terminal) {
            this.options.onError?.(error);
            return;
          }
          if (!retryable(error)) this.options.onError?.(error);
          else this.scheduleRetry();
        });
    }, delay);
    timer.unref();
    this.retryTimer = timer;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    // Stop intake/scheduling immediately so an in-flight startup cannot start
    // a background chain after its last await. Storage is caller-owned.
    this.options.runtime.stop();
  }
}
