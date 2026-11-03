import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeSwitch,
  RuntimeSwitchError,
  type RuntimeSpawn,
  type RuntimeSpawnOptions,
} from '../src/account/runtime-switch';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  killSignal: NodeJS.Signals | number | undefined;
  /** Model real process teardown: normal kill emits close unless told otherwise. */
  killMode: 'close' | 'silent' | 'throw' = 'close';
  killDelayMs = 0;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal;
    const mode = this.killMode;
    if (mode === 'throw') throw Object.assign(new Error('EPERM: kill refused'), { code: 'EPERM' });
    if (mode === 'close') setTimeout(() => this.emit('close', null), this.killDelayMs);
    return true;
  }
}

interface Call {
  command: string;
  args: string[];
  options: RuntimeSpawnOptions;
  child: FakeChild;
}

function fakeSpawn(respond: (child: FakeChild, index: number) => void) {
  const calls: Call[] = [];
  const spawn: RuntimeSpawn = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args: [...args], options, child });
    queueMicrotask(() => respond(child, calls.length - 1));
    return child as unknown as ReturnType<RuntimeSpawn>;
  };
  return { calls, spawn };
}

function succeed(child: FakeChild, stdout: string): void {
  child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', 0);
}

const listJson = JSON.stringify({
  schema_version: 1,
  command: 'list',
  accounts: [
    {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      short_id: 'abcd1234',
      name: 'Work',
      email: 'person@example.com',
      plan_type: 'pro',
      auth_mode: 'chatgpt',
      auto_switch_disabled: false,
      current: true,
      chatgpt_account_is_fedramp: false,
      created_at: 1_800_000_000,
      last_used_at: 1_800_000_100,
      token_last_refresh_at: 1_800_000_100,
      subscription_expires_at: null,
      access_token: 'TOKEN-MUST-NOT-LEAK',
    },
  ],
});

const usageJson = JSON.stringify({
  schema_version: 1,
  command: 'usage',
  all: true,
  show_additional: false,
  generated_at: 1_800_000_200,
  current_account_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  accounts: [
    {
      account: JSON.parse(listJson).accounts[0],
      usage: {
        status: 'ok',
        supported: true,
        plan_type: 'pro',
        five_hour: { used_percent: 10, left_percent: 90, window_minutes: 300, resets_at: 1_800_001_000 },
        weekly: { used_percent: 25, left_percent: 75, window_minutes: 10_080, resets_at: 1_800_100_000 },
        credits: { has_credits: true, unlimited: false, balance: '42' },
        rate_limit_reset_credits_available: 2,
      },
    },
  ],
  forecast: { status: 'not_expected' },
});

describe('runtime-switch runner', () => {
  it('lists accounts with the pinned CLI arguments and masks email fields', async () => {
    const { calls, spawn } = fakeSpawn(child => succeed(child, listJson));
    const runner = createRuntimeSwitch({ spawn });
    const accounts = await runner.list();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('codex-switch');
    expect(calls[0]!.args).toEqual(['list', '--json']);
    expect(calls[0]!.options).toMatchObject({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'Work', shortId: 'abcd1234', current: true });
    expect(accounts[0]!.email).toBe('p***@example.com');
    expect(JSON.stringify(accounts)).not.toContain('person@example.com');
    expect(JSON.stringify(accounts)).not.toContain('TOKEN-MUST-NOT-LEAK');
  });

  it('queries usage with --all --json and parses windows', async () => {
    const { calls, spawn } = fakeSpawn(child => succeed(child, usageJson));
    const runner = createRuntimeSwitch({ spawn });
    const report = await runner.usage();

    expect(calls[0]!.args).toEqual(['usage', '--all', '--json']);
    expect(report.currentAccountId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(report.accounts[0]!.status).toBe('ok');
    expect(report.accounts[0]!.fiveHour.leftPercent).toBe(90);
    expect(report.accounts[0]!.weekly.leftPercent).toBe(75);
    expect(report.forecastStatus).toBe('not_expected');
  });

  it('runs one switch attempt and reports completion separately from runtime identity', async () => {
    const { calls, spawn } = fakeSpawn(child => succeed(child, 'Switched to Work (abcd1234)\n'));
    const runner = createRuntimeSwitch({ spawn });
    const result = await runner.switchAccount('abcd1234');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['switch', 'abcd1234']);
    expect(result).toEqual({
      alias: 'abcd1234',
      commandCompleted: true,
      runtimeVerified: false,
      switchedTo: { name: 'Work', shortId: 'abcd1234' },
    });
  });

  it.each(['--force', '-work', 'a b', 'x;rm -rf /', '$(whoami)', '`id`', '../other', 'line\nbreak'])(
    'rejects an unsafe selector before spawning: %s',
    async alias => {
      const { calls, spawn } = fakeSpawn(child => succeed(child, ''));
      const runner = createRuntimeSwitch({ spawn });
      await expect(runner.switchAccount(alias)).rejects.toMatchObject({ code: 'invalid_alias' });
      expect(calls).toHaveLength(0);
    },
  );

  it('classifies a missing executable without exposing the OS error', async () => {
    const { spawn } = fakeSpawn(child => {
      child.emit('error', Object.assign(new Error('spawn codex-switch ENOENT secret=/home/me/token'), { code: 'ENOENT' }));
    });
    const runner = createRuntimeSwitch({ spawn });
    const error = await runner.list().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RuntimeSwitchError);
    expect((error as RuntimeSwitchError).code).toBe('not_found');
    expect((error as Error).message).not.toContain('secret');
  });

  it('bounds a hung command and kills it', async () => {
    const { calls, spawn } = fakeSpawn(() => { /* never responds */ });
    const runner = createRuntimeSwitch({ spawn, listTimeoutMs: 10, cleanupTimeoutMs: 200 });
    await expect(runner.list()).rejects.toMatchObject({ code: 'timeout' });
    expect(calls[0]!.child.killed).toBe(true);
  });

  it('keeps the switch lock until a timed-out child is confirmed closed', async () => {
    const { calls, spawn } = fakeSpawn(child => {
      child.killMode = 'close';
      child.killDelayMs = 60;
    });
    const runner = createRuntimeSwitch({ spawn, switchTimeoutMs: 10, cleanupTimeoutMs: 500 });
    const first = runner.switchAccount('Work');
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // Timeout has fired, but close has not: a second writer must still be rejected.
    await new Promise(resolve => setTimeout(resolve, 30));
    await expect(runner.switchAccount('Other')).rejects.toMatchObject({ code: 'busy' });
    expect(calls).toHaveLength(1);

    await expect(first).rejects.toMatchObject({ code: 'timeout' });
    // Close was observed before the lock was released, so a new switch may run.
    const second = runner.switchAccount('Other');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    succeed(calls[1]!.child, 'Switched to Other (beef5678)\n');
    await expect(second).resolves.toMatchObject({ commandCompleted: true, runtimeVerified: false });
  });

  it.each(['silent', 'throw'] as const)(
    'blocks future switches when cleanup close cannot be confirmed (%s)',
    async killMode => {
      const { calls, spawn } = fakeSpawn(child => { child.killMode = killMode; });
      const runner = createRuntimeSwitch({ spawn, switchTimeoutMs: 10, cleanupTimeoutMs: 20 });

      await expect(runner.switchAccount('Work')).rejects.toMatchObject({ code: 'cleanup_required' });
      await expect(runner.switchAccount('Other')).rejects.toMatchObject({ code: 'cleanup_required' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.child.killed).toBe(true);
    },
  );

  it('reports a failed exit without returning stderr', async () => {
    const { spawn } = fakeSpawn(child => {
      child.stderr.emit('data', Buffer.from('refresh_token=SECRET-VALUE'));
      child.emit('close', 1);
    });
    const runner = createRuntimeSwitch({ spawn });
    const error = await runner.switchAccount('Work').catch((reason: unknown) => reason);

    expect((error as RuntimeSwitchError).code).toBe('failed');
    expect((error as Error).message).not.toContain('SECRET-VALUE');
  });

  it('stops reading output beyond the configured limit', async () => {
    const { calls, spawn } = fakeSpawn(child => {
      child.stdout.emit('data', Buffer.alloc(32, 0x61));
      child.emit('close', 0);
    });
    const runner = createRuntimeSwitch({ spawn, maxOutputBytes: 8 });
    await expect(runner.list()).rejects.toMatchObject({ code: 'output_too_large' });
    expect(calls[0]!.child.killed).toBe(true);
  });

  it('fails closed on an unexpected JSON schema', async () => {
    const { spawn } = fakeSpawn(child => succeed(child, JSON.stringify({ schema_version: 2, command: 'list', accounts: [] })));
    const runner = createRuntimeSwitch({ spawn });
    await expect(runner.list()).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('never overlaps two switches through the existing transition lock', async () => {
    const { calls, spawn } = fakeSpawn(() => { /* first switch stays pending */ });
    const runner = createRuntimeSwitch({ spawn });
    const first = runner.switchAccount('Work');
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    await expect(runner.switchAccount('Other')).rejects.toMatchObject({ code: 'busy' });
    expect(calls).toHaveLength(1);

    succeed(calls[0]!.child, 'Switched to Work (abcd1234)\n');
    await expect(first).resolves.toMatchObject({ commandCompleted: true, runtimeVerified: false });
  });
});
