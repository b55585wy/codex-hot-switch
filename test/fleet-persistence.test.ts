import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetInbox } from '../src/fleet/inbox';
import { commandId, type FleetCommand } from '../src/fleet/model';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});
function command(): FleetCommand {
  const event = { kind: 'message' as const, data: { messageId: 'om_1', chatId: 'oc_1', senderId: 'ou_owner', chatType: 'group', content: 'run' } };
  return { id: commandId(event, 'mac'), appId: 'app', source: 'win', target: 'mac', createdAt: 1, expiresAt: 100, event };
}
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-fleet-inbox-'));
  roots.push(dir);
  return dir;
}

describe('durable at-most-once dispatch', () => {
  it('allows one of simultaneous claim attempts and survives a fresh process instance', async () => {
    const directory = await root();
    const inbox = new FleetInbox(directory);
    const results = await Promise.all(Array.from({ length: 12 }, () => inbox.claim(command())));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await new FleetInbox(directory).claim(command())).toBe(false);
  });
  it('does not replay a claim left by a crash before dispatch', async () => {
    const directory = await root();
    const inbox = new FleetInbox(directory);
    expect(await inbox.claim(command())).toBe(true);
    const restarted = new FleetInbox(directory);
    expect(await restarted.claim(command())).toBe(false);
    expect(JSON.parse(await readFile(join(directory, `${command().id}.json`), 'utf8')).state).toBe('accepted');
  });
  it('records rejection and dispatch separately from model completion', async () => {
    const directory = await root();
    const inbox = new FleetInbox(directory);
    await inbox.claim(command());
    await inbox.finish(command().id, 'dispatched');
    expect(JSON.parse(await readFile(join(directory, `${command().id}.json`), 'utf8')).state).toBe('dispatched');
    expect(await new FleetInbox(directory).claim(command())).toBe(false);
  });
  it('rejects path traversal and does not treat filesystem permission/path failures as duplicates', async () => {
    const directory = await root();
    await expect(new FleetInbox(directory).claim({ ...command(), id: '../../outside' })).rejects.toThrow();
    const blocked = join(directory, `${command().id}.json`);
    await mkdir(blocked);
    await expect(new FleetInbox(directory).claim(command())).rejects.toThrow('不是普通文件');
    await expect(new FleetInbox(directory).finish(command().id, 'rejected')).rejects.toThrow();
    const { writeFile } = await import('node:fs/promises');
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'blocked');
    await expect(new FleetInbox(file).claim(command())).rejects.toThrow();
  });
});
