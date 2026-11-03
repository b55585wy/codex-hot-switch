import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';
import { isAccountTransitioning, withAccountTransition } from './transition';

/**
 * Bounded wrapper around the local `codex-switch` 0.3.2 executable.
 *
 * This module is the only Bridge code that invokes codex-switch. It is
 * deliberately narrower than the CLI: list, usage and an explicit switch.
 * Login, import and export are never exposed here because they either need an
 * interactive terminal or produce credential material.
 *
 * CLI JSON shapes were taken from the sibling runtime-switch source
 * (`src/json_output.rs`), not guessed: schema_version 1, `list` and `usage`
 * documents with an `accounts` array. Unknown shapes fail closed instead of
 * being rendered.
 */

export type RuntimeSwitchErrorCode =
  | 'not_found'
  | 'invalid_alias'
  | 'spawn_failed'
  | 'timeout'
  | 'output_too_large'
  | 'failed'
  | 'invalid_output'
  | 'busy'
  | 'cleanup_required';

const SAFE_MESSAGES: Record<RuntimeSwitchErrorCode, string> = {
  not_found: '未找到 codex-switch 可执行文件。',
  invalid_alias: '账号别名格式无效。',
  spawn_failed: '无法启动 codex-switch。',
  timeout: 'codex-switch 未在限定时间内返回。',
  output_too_large: 'codex-switch 输出超过安全上限。',
  failed: 'codex-switch 未成功完成。',
  invalid_output: 'codex-switch 返回的数据格式无法验证。',
  busy: '另一个账号操作仍在进行。',
  cleanup_required: '上一个 codex-switch 进程未能确认退出，已禁止新的账号操作。',
};

/** Safe wording only: no stderr, stdout or tool diagnostics are ever attached. */
export class RuntimeSwitchError extends Error {
  constructor(readonly code: RuntimeSwitchErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'RuntimeSwitchError';
  }
}

export interface RuntimeSwitchAccount {
  id: string;
  shortId: string;
  name: string;
  /** Already masked by this adapter; the raw address never leaves. */
  email?: string;
  planType?: string;
  authMode: string;
  current: boolean;
  autoSwitchDisabled: boolean;
  lastUsedAt?: number;
}

export interface RuntimeUsageWindow {
  usedPercent: number | null;
  leftPercent: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface RuntimeCredits {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance?: string;
}

export type RuntimeUsageStatus = 'ok' | 'unsupported' | 'error' | 'unavailable';

export interface RuntimeAccountUsage {
  account: RuntimeSwitchAccount;
  status: RuntimeUsageStatus;
  fiveHour: RuntimeUsageWindow;
  weekly: RuntimeUsageWindow;
  credits?: RuntimeCredits;
  resetCreditsAvailable?: number;
  resetCreditsExpiresAt?: number;
}

export interface RuntimeUsageReport {
  generatedAt: number;
  currentAccountId?: string;
  accounts: RuntimeAccountUsage[];
  forecastStatus?: string;
}

/**
 * A completed `switch` command is not proof that every running Codex/TUI has
 * adopted the account. `runtimeVerified` is therefore always false here.
 */
export interface RuntimeSwitchOutcome {
  alias: string;
  commandCompleted: true;
  runtimeVerified: false;
  switchedTo?: { name: string; shortId?: string };
}

export interface RuntimeSpawnOptions {
  shell: false;
  windowsHide: true;
  stdio: ['ignore', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
}

type RuntimeChild = Pick<ChildProcess, 'stdout' | 'stderr' | 'kill'> & {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
};

export type RuntimeSpawn = (
  command: string,
  args: readonly string[],
  options: RuntimeSpawnOptions,
) => RuntimeChild;

export interface RuntimeSwitchOptions {
  /** Executable or absolute path; defaults to CODEX_SWITCH_BIN or codex-switch. */
  executable?: string;
  /** Injectable for tests; production uses the cross-platform spawn helper. */
  spawn?: RuntimeSpawn;
  listTimeoutMs?: number;
  usageTimeoutMs?: number;
  switchTimeoutMs?: number;
  /** Bound for confirming that a killed process has actually closed. */
  cleanupTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Injectable state checks so unit tests never touch a real account store. */
  isTransitioning?: () => boolean;
  withTransition?: <T>(operation: () => Promise<T>) => Promise<T>;
}

const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LIST_TIMEOUT_MS = 15_000;
const USAGE_TIMEOUT_MS = 60_000;
const SWITCH_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strict allow-list: no whitespace, slashes, quotes or leading option dash. */
export function isSafeRuntimeSelector(value: string): boolean {
  return SELECTOR.test(value.trim());
}

export function validateRuntimeSelector(value: string): string {
  const selector = value.trim();
  if (!SELECTOR.test(selector)) throw new RuntimeSwitchError('invalid_alias');
  return selector;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** Mask before the value can reach a Feishu reply or a log line. */
function maskEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim();
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return undefined;
  const domain = email.slice(at + 1).toLowerCase();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(domain) || domain.includes('..')) return undefined;
  const local = email.slice(0, at);
  return `${local[0] ?? ''}***@${domain}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  const n = finiteNumber(value);
  return n === null ? null : Math.trunc(n);
}

function percent(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n === null) return null;
  return Math.min(100, Math.max(0, n));
}

function parseJson(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
  } catch {
    throw new RuntimeSwitchError('invalid_output');
  }
  if (!isObject(value) || value.schema_version !== 1) throw new RuntimeSwitchError('invalid_output');
  return value;
}

function parseAccount(value: unknown): RuntimeSwitchAccount {
  if (!isObject(value)) throw new RuntimeSwitchError('invalid_output');
  const id = boundedText(value.id, 128);
  const name = boundedText(value.name, 80);
  if (!id || !name) throw new RuntimeSwitchError('invalid_output');
  const shortId = boundedText(value.short_id, 40) ?? id.slice(0, 8);
  const authMode = boundedText(value.auth_mode, 24) ?? 'unknown';
  const lastUsedAt = integer(value.last_used_at);
  const email = maskEmail(value.email);
  const planType = boundedText(value.plan_type, 32);
  return {
    id,
    shortId,
    name,
    ...(email ? { email } : {}),
    ...(planType ? { planType } : {}),
    authMode,
    current: value.current === true,
    autoSwitchDisabled: value.auto_switch_disabled === true,
    ...(lastUsedAt === null ? {} : { lastUsedAt }),
  };
}

function parseWindow(value: unknown): RuntimeUsageWindow {
  if (!isObject(value)) {
    return { usedPercent: null, leftPercent: null, windowMinutes: null, resetsAt: null };
  }
  const usedPercent = percent(value.used_percent);
  const leftPercent = percent(value.left_percent)
    ?? (usedPercent === null ? null : Math.min(100, Math.max(0, 100 - usedPercent)));
  return {
    usedPercent,
    leftPercent,
    windowMinutes: integer(value.window_minutes),
    resetsAt: integer(value.resets_at),
  };
}

function parseCredits(value: unknown): RuntimeCredits | undefined {
  if (!isObject(value)) return undefined;
  return {
    hasCredits: typeof value.has_credits === 'boolean' ? value.has_credits : null,
    unlimited: typeof value.unlimited === 'boolean' ? value.unlimited : null,
    ...(boundedText(value.balance, 40) ? { balance: boundedText(value.balance, 40) } : {}),
  };
}

function parseUsageStatus(value: unknown): RuntimeUsageStatus {
  return value === 'ok' || value === 'unsupported' || value === 'error' || value === 'unavailable'
    ? value
    : 'error';
}

export function parseAccountList(stdout: string): RuntimeSwitchAccount[] {
  const document = parseJson(stdout);
  if (document.command !== 'list' || !Array.isArray(document.accounts)) {
    throw new RuntimeSwitchError('invalid_output');
  }
  return document.accounts.map(parseAccount);
}

export function parseUsageReport(stdout: string): RuntimeUsageReport {
  const document = parseJson(stdout);
  if (document.command !== 'usage' || !Array.isArray(document.accounts)) {
    throw new RuntimeSwitchError('invalid_output');
  }
  const accounts = document.accounts.map((entry): RuntimeAccountUsage => {
    if (!isObject(entry) || !isObject(entry.usage)) throw new RuntimeSwitchError('invalid_output');
    const usage = entry.usage;
    const resetAvailable = integer(usage.rate_limit_reset_credits_available);
    const resetExpires = integer(usage.rate_limit_reset_credits_next_expires_at);
    const credits = parseCredits(usage.credits);
    return {
      account: parseAccount(entry.account),
      status: parseUsageStatus(usage.status),
      fiveHour: parseWindow(usage.five_hour),
      weekly: parseWindow(usage.weekly),
      ...(credits ? { credits } : {}),
      ...(resetAvailable === null ? {} : { resetCreditsAvailable: Math.max(0, resetAvailable) }),
      ...(resetExpires === null ? {} : { resetCreditsExpiresAt: resetExpires }),
    };
  });
  const forecast = isObject(document.forecast) ? boundedText(document.forecast.status, 32) : undefined;
  const currentAccountId = boundedText(document.current_account_id, 128);
  return {
    generatedAt: integer(document.generated_at) ?? Math.floor(Date.now() / 1000),
    ...(currentAccountId ? { currentAccountId } : {}),
    accounts,
    ...(forecast ? { forecastStatus: forecast } : {}),
  };
}

export function parseSwitchOutcome(stdout: string, alias: string): RuntimeSwitchOutcome {
  // Human output is `Switched to NAME (SHORTID)`. The command's exit code is
  // authoritative; a changed label must not turn a completed switch into a
  // failure, so parsing is best-effort metadata only.
  const line = stdout.split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith('Switched to '));
  if (!line) return { alias, commandCompleted: true, runtimeVerified: false };
  const match = /^Switched to (.*) \(([^()]*)\)$/.exec(line);
  const name = boundedText(match?.[1], 80);
  if (!name) return { alias, commandCompleted: true, runtimeVerified: false };
  const shortId = boundedText(match?.[2], 40);
  return {
    alias,
    commandCompleted: true,
    runtimeVerified: false,
    switchedTo: { name, ...(shortId ? { shortId } : {}) },
  };
}

function spawnFailure(error: unknown): RuntimeSwitchError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // ENOENT/EACCES/ENOTDIR all mean "this local tool cannot be started"; the
  // operator action is the same and the raw OS message stays out of replies.
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') return new RuntimeSwitchError('not_found');
  return new RuntimeSwitchError('spawn_failed');
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: RuntimeSpawnOptions,
): RuntimeChild {
  return spawnProcess(command, args, options) as unknown as RuntimeChild;
}

export interface RuntimeSwitch {
  executable: string;
  list(): Promise<RuntimeSwitchAccount[]>;
  usage(): Promise<RuntimeUsageReport>;
  switchAccount(alias: string): Promise<RuntimeSwitchOutcome>;
}

export function createRuntimeSwitch(options: RuntimeSwitchOptions = {}): RuntimeSwitch {
  const executable = options.executable?.trim()
    || process.env.CODEX_SWITCH_BIN?.trim()
    || 'codex-switch';
  const spawn = options.spawn ?? defaultSpawn;
  const listTimeoutMs = options.listTimeoutMs ?? LIST_TIMEOUT_MS;
  const usageTimeoutMs = options.usageTimeoutMs ?? USAGE_TIMEOUT_MS;
  const switchTimeoutMs = options.switchTimeoutMs ?? SWITCH_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const isTransitioning = options.isTransitioning ?? isAccountTransitioning;
  const withTransition = options.withTransition ?? withAccountTransition;
  // Once a switch process cannot be proven closed, no later switch may start a
  // second writer against the account store. The latch is intentionally sticky
  // for this runner instance; recovery requires confirming/killing the process
  // and restarting the Bridge.
  let cleanupBlocked = false;

  interface ExecutionResult {
    ok: boolean;
    text?: string;
    error?: RuntimeSwitchError;
    /** true when this result requires killing and observing the child. */
    terminate?: boolean;
  }

  function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
    return new Promise(resolveWait => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolveWait(false);
      }, Math.max(1, timeoutMs));
      void closed.then(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolveWait(true);
      });
    });
  }

  function execute(args: readonly string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!executable) {
        reject(new RuntimeSwitchError('not_found'));
        return;
      }
      let child: RuntimeChild;
      try {
        child = spawn(executable, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });
      } catch (error) {
        reject(spawnFailure(error));
        return;
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      // Close is the only proof that the OS has torn the process down. Hold the
      // result (and therefore the transition lock) until it is observed.
      const closed = new Promise<void>(resolveClosed => {
        child.once('close', () => resolveClosed());
      });

      const settle = (result: ExecutionResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (result.ok) {
          resolve(result.text ?? '');
          return;
        }
        const error = result.error ?? new RuntimeSwitchError('failed');
        void (async () => {
          if (result.terminate) {
            try { child.kill('SIGKILL'); } catch { /* close observation decides below */ }
            if (!await waitForClose(closed, cleanupTimeoutMs)) {
              // Never release the transition lock into a second writer when the
              // first process may still be alive. Block future switches instead.
              cleanupBlocked = true;
              reject(new RuntimeSwitchError('cleanup_required'));
              return;
            }
          }
          reject(error);
        })();
      };

      // Must attach an error listener before any async emit: an unhandled
      // 'error' event would crash the daemon instead of producing a safe reply.
      child.once('error', error => settle({ ok: false, error: spawnFailure(error) }));
      child.once('close', code => settle({
        ok: code === 0,
        text: code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined,
        ...(code === 0 ? {} : { error: new RuntimeSwitchError('failed') }),
      }));
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxOutputBytes) {
          settle({ ok: false, error: new RuntimeSwitchError('output_too_large'), terminate: true });
          return;
        }
        chunks.push(buffer);
      });
      // Drain but never retain stderr: it is not a user-facing channel and may
      // contain local diagnostics or credential material.
      child.stderr?.on('data', () => undefined);
      if (!settled) {
        timer = setTimeout(
          () => settle({ ok: false, error: new RuntimeSwitchError('timeout'), terminate: true }),
          timeoutMs,
        );
      }
    });
  }

  async function list(): Promise<RuntimeSwitchAccount[]> {
    return parseAccountList(await execute(['list', '--json'], listTimeoutMs));
  }

  async function usage(): Promise<RuntimeUsageReport> {
    return parseUsageReport(await execute(['usage', '--all', '--json'], usageTimeoutMs));
  }

  async function switchAccount(alias: string): Promise<RuntimeSwitchOutcome> {
    const selector = validateRuntimeSelector(alias);
    if (cleanupBlocked) throw new RuntimeSwitchError('cleanup_required');
    if (isTransitioning()) throw new RuntimeSwitchError('busy');
    let started = false;
    try {
      return await withTransition(async () => {
        started = true;
        // Re-check after acquiring the lock: a concurrent timeout cleanup may
        // have failed between the fast-path check and this point.
        if (cleanupBlocked) throw new RuntimeSwitchError('cleanup_required');
        // Single attempt only. A switch can mutate auth.json; retrying it is
        // never safe. The existing account transition lock keeps /account and
        // runtime switches from overlapping. execute() does not settle a
        // timeout until the killed child is confirmed closed.
        const stdout = await execute(['switch', selector], switchTimeoutMs);
        return parseSwitchOutcome(stdout, selector);
      });
    } catch (error) {
      if (error instanceof RuntimeSwitchError) throw error;
      // Thrown by the transition guard before our operation ran.
      if (!started) throw new RuntimeSwitchError('busy');
      throw new RuntimeSwitchError('failed');
    }
  }

  return { executable, list, usage, switchAccount };
}
