import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  readFreshCodexAccount, readDaemonCodexAccount, restartCodexRuntime,
  type CodexRuntimeDeps, type RuntimeAccountClient,
} from '../src/account/codex-runtime';

// Every test must inject process/client dependencies; accidental real effects fail immediately.
vi.mock('../src/platform/spawn', () => ({ spawnProcess: () => { throw new Error('real spawn forbidden'); } }));
vi.mock('../src/agent/codex-appserver/locate', () => ({ resolveCodexBin: () => { throw new Error('real lookup forbidden'); } }));
vi.mock('../src/agent/codex-appserver/app-server-client', () => ({
  AppServerClient: class { constructor() { throw new Error('real client forbidden'); } },
}));

const email = 'new@example.com';
const sensitiveFailure = new Error('private-token-and-full-account@example.com');

function client(label: string, events: string[], account: unknown = { type: 'chatgpt', email }): RuntimeAccountClient {
  return {
    connect: vi.fn(async () => { events.push(`${label}:connect`); }),
    request: vi.fn(async () => { events.push(`${label}:read`); return { account }; }),
    close: vi.fn(async () => { events.push(`${label}:close`); }),
  };
}

function fixture() {
  const events: string[] = [];
  const fresh = client('fresh', events);
  const shared = client('shared', events);
  const deps: CodexRuntimeDeps = {
    cwd: 'C:\\fixture work',
    resolveBin: vi.fn(() => 'C:\\fixture tools\\codex.cmd'),
    createFreshClient: vi.fn(() => fresh),
    createSharedClient: vi.fn(() => shared),
    closeBridgeOwnedClients: vi.fn(async () => { events.push('bridge:close'); }),
    restartDaemon: vi.fn(async () => { events.push('daemon:restart'); }),
  };
  return { deps, fresh, shared, events };
}

describe('Codex account runtime adoption', () => {
  it('bounds an unresponsive handshake and closes its own client without restarting', async () => {
    vi.useFakeTimers();
    try {
      const f=fixture();vi.mocked(f.fresh.connect).mockImplementation(() => new Promise(() => {}));
      const result=expect(readFreshCodexAccount(f.deps)).rejects.toMatchObject({code:'FRESH_ACCOUNT_READ_FAILED'});
      await vi.advanceTimersByTimeAsync(15001);await result;
      expect(f.fresh.close).toHaveBeenCalledOnce();expect(f.deps.restartDaemon).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });
  it('verifies the selected identity by its email hash without accepting a wrong daemon account', async () => {
    const f=fixture(); const emailHash=createHash('sha256').update(email).digest('hex');
    expect(await restartCodexRuntime({emailHash}, f.deps)).toMatchObject({status:'verified'});
    const wrong=fixture();vi.mocked(wrong.shared.request).mockResolvedValue({account:{type:'chatgpt',email:'other@example.com'}});
    await expect(restartCodexRuntime({emailHash},wrong.deps)).rejects.toMatchObject({code:'DAEMON_ACCOUNT_MISMATCH'});
  });
  it.each(['bad','a'.repeat(63),'x'.repeat(64)])('rejects malformed identity hashes before process operations: %s', async emailHash => {
    const f=fixture();await expect(restartCodexRuntime({emailHash},f.deps)).rejects.toMatchObject({code:'INVALID_ACCOUNT_EMAIL'});
    expect(f.deps.resolveBin).not.toHaveBeenCalled();
  });
  it('reads the currently loaded daemon account without creating a fresh server or restarting', async () => {
    const f=fixture(); expect(await readDaemonCodexAccount(f.deps)).toEqual({type:'chatgpt',email});
    expect(f.deps.createFreshClient).not.toHaveBeenCalled(); expect(f.deps.restartDaemon).not.toHaveBeenCalled();expect(f.shared.close).toHaveBeenCalledOnce();
  });
  // Requirements: metadata only, strict identity checks, ordered cleanup/restart/verification,
  // fixed argv, no task RPC, and safe failure with cleanup at every state transition.
  it('reads metadata from a fresh independent server and closes it without restart or shared access', async () => {
    const { deps, fresh, events } = fixture();
    vi.mocked(fresh.request).mockResolvedValue({ account: { type: 'chatgpt', email: ' New@Example.com ', token: 'must-not-return' } });
    expect(await readFreshCodexAccount(deps)).toEqual({ type: 'chatgpt', email });
    expect(events).toEqual(['fresh:connect', 'fresh:close']);
    expect(fresh.request).toHaveBeenCalledOnce();
    expect(fresh.request).toHaveBeenCalledWith('account/read', { refreshToken: false }, 15_000);
    expect(deps.restartDaemon).not.toHaveBeenCalled();
    expect(deps.createSharedClient).not.toHaveBeenCalled();
  });

  it('verifies both native credentials and the restarted daemon with no task methods', async () => {
    const { deps, fresh, shared, events } = fixture();
    const result = await restartCodexRuntime(' NEW@EXAMPLE.COM ', deps);
    expect(result).toEqual({ status: 'verified', accountType: 'chatgpt', maskedEmail: 'n***@example.com' });
    expect(JSON.stringify(result)).not.toContain(email);
    expect(events).toEqual([
      'fresh:connect', 'fresh:read', 'fresh:close', 'bridge:close', 'daemon:restart',
      'shared:connect', 'shared:read', 'shared:close',
    ]);
    expect(deps.createFreshClient).toHaveBeenCalledWith({ bin: 'C:\\fixture tools\\codex.cmd', cwd: 'C:\\fixture work' });
    expect(deps.restartDaemon).toHaveBeenCalledOnce();
    expect(deps.restartDaemon).toHaveBeenCalledWith('C:\\fixture tools\\codex.cmd',
      ['app-server', 'daemon', 'restart'], { cwd: 'C:\\fixture work', windowsHide: true, shell: false });
    for (const connection of [fresh, shared]) {
      expect(connection.request).toHaveBeenCalledOnce();
      expect(connection.request).toHaveBeenCalledWith('account/read', { refreshToken: false }, 15_000);
      expect(connection.close).toHaveBeenCalledOnce();
    }
  });

  it.each(['', '  ', 'missing-at', 'a@@example.com', 'a@example.com\n&calc', `a${'x'.repeat(321)}@example.com`])(
    'rejects an invalid expected identity before any client or command (%j)', async expected => {
      const { deps } = fixture();
      await expect(restartCodexRuntime(expected, deps)).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_EMAIL' });
      expect(deps.resolveBin).not.toHaveBeenCalled();
      expect(deps.restartDaemon).not.toHaveBeenCalled();
    },
  );

  it('requires complete Bridge cleanup wiring before it creates a fresh server', async () => {
    const { deps } = fixture();
    const { closeBridgeOwnedClients: _unused, ...partial } = deps;
    await expect(restartCodexRuntime(email, partial)).rejects.toMatchObject({ code: 'BRIDGE_CLEANUP_REQUIRED' });
    expect(deps.createFreshClient).not.toHaveBeenCalled();
  });

  it('reports a missing Codex binary before creating clients', async () => {
    const { deps } = fixture();
    deps.resolveBin = () => null;
    await expect(readFreshCodexAccount(deps)).rejects.toMatchObject({ code: 'CODEX_NOT_FOUND' });
    expect(deps.createFreshClient).not.toHaveBeenCalled();
  });

  it('does not expose resolver diagnostics or create clients when binary lookup fails', async () => {
    const { deps } = fixture();
    deps.resolveBin = () => { throw sensitiveFailure; };
    const error = await readFreshCodexAccount(deps).catch(error => error as Error);
    expect(error).toMatchObject({ code: 'CODEX_NOT_FOUND' });
    expect(String(error)).not.toContain(sensitiveFailure.message);
    expect(deps.createFreshClient).not.toHaveBeenCalled();
  });

  it.each([{ type: 'apiKey' }, { type: 'amazonBedrock' }, { type: 'chatgpt', email: 'old@example.com' }])(
    'closes a mismatched fresh account and leaves the daemon untouched (%j)', async account => {
      const { deps, fresh } = fixture();
      vi.mocked(fresh.request).mockResolvedValue({ account });
      await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'FRESH_ACCOUNT_MISMATCH' });
      expect(fresh.close).toHaveBeenCalledOnce();
      expect(deps.closeBridgeOwnedClients).not.toHaveBeenCalled();
      expect(deps.restartDaemon).not.toHaveBeenCalled();
    },
  );

  it.each([null, {}, { type: 'chatgpt' }, { type: 'chatgpt', email: 'invalid' }, { type: 'unknown' }])(
    'does not restart when fresh account metadata is missing or invalid (%j)', async account => {
      const { deps, fresh } = fixture();
      vi.mocked(fresh.request).mockResolvedValue({ account });
      await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'FRESH_ACCOUNT_READ_FAILED' });
      expect(fresh.close).toHaveBeenCalledOnce();
      expect(deps.restartDaemon).not.toHaveBeenCalled();
    },
  );

  it.each(['connect', 'request'] as const)('closes a fresh client after %s fails, without exposing raw errors', async operation => {
    const { deps, fresh } = fixture();
    vi.mocked(fresh[operation]).mockRejectedValue(sensitiveFailure);
    const error = await restartCodexRuntime(email, deps).catch(error => error as Error);
    expect(error).toMatchObject({ code: 'FRESH_ACCOUNT_READ_FAILED' });
    expect(String(error)).not.toContain(sensitiveFailure.message);
    expect(fresh.close).toHaveBeenCalledOnce();
    expect(deps.restartDaemon).not.toHaveBeenCalled();
  });

  it('sanitizes fresh factory failures and does not restart', async () => {
    const { deps } = fixture();
    vi.mocked(deps.createFreshClient).mockRejectedValue(sensitiveFailure);
    await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'FRESH_ACCOUNT_READ_FAILED' });
    expect(deps.restartDaemon).not.toHaveBeenCalled();
  });

  it('refuses restart if its fresh verifier could not close', async () => {
    const { deps, fresh } = fixture();
    vi.mocked(fresh.close).mockRejectedValue(sensitiveFailure);
    await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'FRESH_ACCOUNT_CLOSE_FAILED' });
    expect(deps.closeBridgeOwnedClients).not.toHaveBeenCalled();
    expect(deps.restartDaemon).not.toHaveBeenCalled();
  });

  it('preserves the original read failure when cleanup also fails', async () => {
    const { deps, fresh } = fixture();
    vi.mocked(fresh.request).mockRejectedValue(sensitiveFailure);
    vi.mocked(fresh.close).mockRejectedValue(sensitiveFailure);
    await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'FRESH_ACCOUNT_READ_FAILED' });
  });

  it('does not restart while any Bridge-owned connection failed to close', async () => {
    const { deps } = fixture();
    vi.mocked(deps.closeBridgeOwnedClients).mockRejectedValue(sensitiveFailure);
    await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'BRIDGE_CLOSE_FAILED' });
    expect(deps.restartDaemon).not.toHaveBeenCalled();
    expect(deps.createSharedClient).not.toHaveBeenCalled();
  });

  it('does not verify or claim success after an unconfirmed daemon restart', async () => {
    const { deps } = fixture();
    vi.mocked(deps.restartDaemon).mockRejectedValue(sensitiveFailure);
    const error = await restartCodexRuntime(email, deps).catch(error => error as Error);
    expect(error).toMatchObject({ code: 'DAEMON_RESTART_FAILED' });
    expect(String(error)).not.toContain(sensitiveFailure.message);
    expect(deps.createSharedClient).not.toHaveBeenCalled();
  });

  it.each(['connect', 'request'] as const)('closes the shared verifier if %s fails after restart', async operation => {
    const { deps, shared } = fixture();
    vi.mocked(shared[operation]).mockRejectedValue(sensitiveFailure);
    await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'DAEMON_ACCOUNT_READ_FAILED' });
    expect(shared.close).toHaveBeenCalledOnce();
    expect(deps.restartDaemon).toHaveBeenCalledOnce();
  });

  it('sanitizes shared factory failure after restart', async () => {
    const { deps } = fixture();
    vi.mocked(deps.createSharedClient).mockRejectedValue(sensitiveFailure);
    await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'DAEMON_ACCOUNT_READ_FAILED' });
  });

  it.each([{ type: 'chatgpt', email: 'old@example.com' }, { type: 'apiKey' }])(
    'reports failed adoption if the restarted daemon has a different identity (%j)', async account => {
      const { deps, shared } = fixture();
      vi.mocked(shared.request).mockResolvedValue({ account });
      await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'DAEMON_ACCOUNT_MISMATCH' });
      expect(shared.close).toHaveBeenCalledOnce();
    },
  );

  it('does not report verified when the shared verifier fails to close', async () => {
    const { deps, shared } = fixture();
    vi.mocked(shared.close).mockRejectedValue(sensitiveFailure);
    await expect(restartCodexRuntime(email, deps)).rejects.toMatchObject({ code: 'DAEMON_ACCOUNT_CLOSE_FAILED' });
  });

  it('never inserts account text into command argv, including shell punctuation', async () => {
    const { deps, fresh, shared } = fixture();
    const punctuationEmail = "a'$(calc)&@example.com";
    for (const connection of [fresh, shared]) vi.mocked(connection.request).mockResolvedValue({ account: { type: 'chatgpt', email: punctuationEmail } });
    await expect(restartCodexRuntime(punctuationEmail, deps)).resolves.toMatchObject({ status: 'verified' });
    expect(deps.restartDaemon).toHaveBeenCalledOnce();
    expect(deps.restartDaemon).toHaveBeenCalledWith('C:\\fixture tools\\codex.cmd',
      ['app-server', 'daemon', 'restart'], { cwd: 'C:\\fixture work', windowsHide: true, shell: false });
  });
});
