import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ private: true }));
const spawn = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]).endsWith('package.json')) {
        return JSON.stringify({ name: '@example/private-bridge', version: '0.6.14', private: state.private });
      }
      return actual.readFileSync(...args);
    },
  };
});
vi.mock('../src/platform/spawn', () => ({ spawnProcess: spawn }));

import { checkUpdate, installLatest, latestVersion } from '../src/service/update';

beforeEach(() => {
  state.private = true;
  spawn.mockReset();
});

describe('private edition update boundary', () => {
  it('does not query an npm registry for a private package', async () => {
    expect(await latestVersion()).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('reports no npm update while retaining the installed version', async () => {
    expect(await checkUpdate()).toMatchObject({ current: '0.6.14', latest: null, hasUpdate: false });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('refuses an npm install before starting a subprocess', async () => {
    expect(await installLatest()).toMatchObject({ ok: false, message: expect.stringContaining('私有仓库') });
    expect(spawn).not.toHaveBeenCalled();
  });
});
