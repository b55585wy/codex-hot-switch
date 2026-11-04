import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * These tests never launch Codex. The launcher is pointed at Node itself as a
 * fake `codex-switch`, with a --require preload that records argv/cwd and exits
 * before any script runs. The native codex.exe is an empty file under a fake
 * npm prefix.
 */

const script = fileURLToPath(new URL('../scripts/codex-managed.ps1', import.meta.url));
const isWindows = process.platform === 'win32';
const temporary: string[] = [];

function makeTemp(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codex-managed-'));
  temporary.push(directory);
  return directory;
}

/** Windows env names are case-insensitive; drop stale spellings before adding. */
function withEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set(Object.keys(overrides).map(name => name.toLowerCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || names.has(name.toLowerCase())) continue;
    env[name] = value;
  }
  return { ...env, ...overrides };
}

function platformTarget(): { packageName: string; triple: string } {
  return process.arch === 'arm64'
    ? { packageName: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
    : { packageName: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' };
}

function installFakeNative(prefix: string): string {
  const { packageName, triple } = platformTarget();
  const native = join(
    prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
    packageName, 'vendor', triple, 'bin', 'codex.exe',
  );
  mkdirSync(dirname(native), { recursive: true });
  writeFileSync(native, 'not-a-real-executable\n');
  return native;
}

/**
 * Node is a real .exe, so argument forwarding is exercised without cmd.exe
 * (which splits `key=value`). The preload exits before Node resolves "run".
 */
function installFakeSwitch(root: string): { executable: string; preload: string; argsFile: string } {
  const preload = join(root, 'record.cjs');
  const argsFile = join(root, 'args.json');
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({',
    '  script: path.basename(process.argv[1] || ""),',
    '  args: process.argv.slice(2),',
    '  cwd: process.cwd(),',
    '}));',
    'process.exit(0);',
    '',
  ].join('\n'));
  return { executable: process.execPath, preload, argsFile };
}

function runLauncher(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  return spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    ...args,
  ], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

afterEach(() => {
  while (temporary.length > 0) {
    rmSync(temporary.pop()!, { recursive: true, force: true });
  }
});

describe.skipIf(!isWindows)('codex-managed launcher', () => {
  it('resolves the npm-vendored native codex.exe and forwards argv/cwd safely', () => {
    const root = makeTemp();
    const prefix = join(root, 'npm-prefix');
    const native = installFakeNative(prefix);
    const fake = installFakeSwitch(root);
    const work = join(root, 'work dir');
    mkdirSync(work, { recursive: true });

    const forwarded = ['--help', 'hello world', '-c', 'model=gpt-5', '--', '-x'];
    const result = runLauncher(forwarded, {
      cwd: work,
      env: withEnv({
        npm_config_prefix: prefix,
        CODEX_SWITCH_BIN: fake.executable,
        CODEX_NATIVE_BIN: '',
        NODE_OPTIONS: '--require ' + fake.preload,
        FAKE_ARGS_FILE: fake.argsFile,
      }),
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const recorded = JSON.parse(readFileSync(fake.argsFile, 'utf8'));
    expect(recorded.script).toBe('run');
    expect(recorded.args).toEqual(['--codex-bin', native, '--', ...forwarded]);
    // Windows can report the same directory through its 8.3 short-name alias.
    expect(realpathSync.native(recorded.cwd).toLowerCase()).toBe(realpathSync.native(work).toLowerCase());
  });

  it('fails clearly when CODEX_SWITCH_BIN points at a missing file', () => {
    const root = makeTemp();
    const work = join(root, 'work');
    mkdirSync(work, { recursive: true });

    const result = runLauncher(['--version'], {
      cwd: work,
      env: withEnv({
        CODEX_SWITCH_BIN: join(root, 'missing', 'codex-switch.exe'),
        CODEX_NATIVE_BIN: '',
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CODEX_SWITCH_BIN');
  });

  it('fails clearly when the npm-vendored native binary cannot be found', () => {
    const root = makeTemp();
    const fake = installFakeSwitch(root);
    const work = join(root, 'work');
    const emptyPrefix = join(root, 'empty-prefix');
    const emptyAppData = join(root, 'empty-appdata');
    const fakeNpmBin = join(root, 'fake-npm');
    mkdirSync(work, { recursive: true });
    mkdirSync(emptyPrefix, { recursive: true });
    mkdirSync(emptyAppData, { recursive: true });
    mkdirSync(fakeNpmBin, { recursive: true });
    writeFileSync(join(fakeNpmBin, 'npm.cmd'), '@echo off\r\nexit /b 1\r\n');

    const result = runLauncher(['--version'], {
      cwd: work,
      env: withEnv({
        PATH: fakeNpmBin + ';' + (process.env.PATH ?? ''),
        npm_config_prefix: emptyPrefix,
        APPDATA: emptyAppData,
        CODEX_SWITCH_BIN: fake.executable,
        CODEX_NATIVE_BIN: '',
        NODE_OPTIONS: '--require ' + fake.preload,
        FAKE_ARGS_FILE: fake.argsFile,
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('@openai/codex');
  });
});
