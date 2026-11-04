import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', () => ({ paths: {
  get projectsFile() { return `${state.root}/projects.json`; },
  get sessionsFile() { return `${state.root}/sessions.json`; },
  get commentsRootDir() { return `${state.root}/comments`; },
} }));
import { addProject, listProjects } from '../src/project/registry';
import { listSessions, upsertSession } from '../src/bot/session-store';
import { migrateFleetOwnership, existingDocumentRoutes } from '../src/fleet';
import { setFleetNodeId } from '../src/fleet/context';

beforeEach(async () => { state.root = await mkdtemp(join(tmpdir(), 'bridge-fleet-migration-')); setFleetNodeId(undefined); });
afterEach(async () => {
  setFleetNodeId(undefined);
  if (!resolve(state.root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
  await rm(state.root, { recursive: true, force: true });
});
const project = { name: 'existing', chatId: 'oc_existing', cwd: '/existing/work', blank: false, createdAt: 1 };
const session = { threadId: 'thread_existing', chatId: project.chatId, cwd: project.cwd,
  backend: 'codex', sessionId: 'original-session-id', summary: 'module', createdAt: 1, updatedAt: 1 };

describe('compatible project and session ownership', () => {
  it('migrates existing identities, working directory and settings without a replacement session', async () => {
    await addProject(project); await upsertSession(session);
    await migrateFleetOwnership('mac');
    expect(await listProjects()).toEqual([{ ...project, ownerNodeId: 'mac' }]);
    expect((await listSessions())[0]).toMatchObject({ ...session, ownerNodeId: 'mac', updatedAt: expect.any(Number) });
  });
  it('rejects foreign ownership before partially migrating local data', async () => {
    await addProject(project); await upsertSession({ ...session, ownerNodeId: 'another-computer' });
    await expect(migrateFleetOwnership('mac')).rejects.toThrow('其他电脑');
    expect((await listProjects())[0]?.ownerNodeId).toBeUndefined();
    expect((await listSessions())[0]?.ownerNodeId).toBe('another-computer');
  });
  it('pins newly created records only when fleet mode has a node context', async () => {
    setFleetNodeId('mac'); await addProject(project); await upsertSession(session);
    expect((await listProjects())[0]?.ownerNodeId).toBe('mac');
    expect((await listSessions())[0]?.ownerNodeId).toBe('mac');
    setFleetNodeId(undefined);
    await addProject({ ...project, name: 'single', chatId: 'oc_single' });
    expect((await listProjects()).find(p => p.name === 'single')?.ownerNodeId).toBeUndefined();
  });
  it('recovers existing document comment routes only from their own local comment directory', async () => {
    await upsertSession({ ...session, cwd: join(state.root, 'comments', 'comment-docx-token123') });
    await upsertSession({ ...session, threadId: 'unrelated', cwd: join(state.root, 'other', 'comment-docx-unrelated') });
    expect(await existingDocumentRoutes()).toEqual(['document:docx:token123']);
  });
});
