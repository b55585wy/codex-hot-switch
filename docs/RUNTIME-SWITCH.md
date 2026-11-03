# Runtime account control (`/runtime`)

This page covers the Feishu-native runtime account entry added on top of
`seven332/codex-switch` 0.3.2. It is separate from the CC Switch `/account`
flow; that flow and its `--restart` behavior are unchanged.

The Bridge is a thin, bounded caller of the local executable. It does not
launch, restart, take over or kill Codex/TUI processes, and it does not perform
automatic quota fallback across an account pool.

## Commands

Admin-only, private chat only. Messages are handled before the DM console and
before normal group task dispatch, so they never reach a model.

| Command | Behavior |
| --- | --- |
| `/runtime` | Read-only list of managed accounts with names, short ids and the explicit switch command |
| `/runtime status` | Read-only status: current auth account plus managed-account count; never switches |
| `/runtime usage` | Read `codex-switch usage --all --json`; never switches |
| `/runtime switch <short-id-or-account-id>` | Run one explicit `codex-switch switch <selector>` attempt |

Only names made of `A-Z a-z 0-9 . _ -` are accepted, must start with a letter or
digit, and must not begin with `-`. This rejects option injection such as
`/runtime switch --force`. The selector is passed as a separate argv element
with `shell: false`.

The menu keys `runtime.accounts`, `runtime.status` and `runtime.usage` are
read-only text entries. `runtime.accounts` explains the explicit
`/runtime switch` command and the managed-only scope; opening it never
switches. See [BOT-MENU.md](BOT-MENU.md).

## First-time login stays local

Run the first login in a terminal on the Bridge host:

```sh
codex-switch login personal
```

Browser OAuth needs that local interactive flow. `/runtime` never performs
login, import or export, and no credentials are read, copied or returned by the
Bridge. Account metadata from `list --json` is filtered down to names, short
ids, plans, states and already-masked email addresses; usage output is filtered
to quota windows. Stderr, tokens and raw auth JSON are never returned to Feishu.

Bare `/runtime` now lists those stored accounts with their names and short ids
and prints the exact `/runtime switch <短码或账号 ID>` command. That list is
read-only: it never switches. `/runtime status` remains the narrow status view.

## Windows managed launcher (`scripts/codex-managed.ps1`)

On Windows the `codex` command on `PATH` is commonly an npm shim
(`codex.exe` -> `bin/codex.js`) rather than the native binary. Launching that
shim through `codex-switch run` adds an extra Node process and a wrapper layer.
The launcher in this repository resolves the native executable that npm already
vendored and passes it directly:

```text
codex-switch run --codex-bin <npm @openai/codex vendored codex.exe> -- <your args>
```

Resolution rules:

- `codex-switch`: `CODEX_SWITCH_BIN` when set, otherwise
  `%USERPROFILE%\.cargo\bin\codex-switch.exe`.
- Native Codex: the vendored path under the global npm root, for example
  `...\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`;
  hoisted and older `vendor/<target>/codex.exe` layouts are also checked. Set
  `CODEX_NATIVE_BIN` to override with an explicit file.
- `x64` maps to `x86_64-pc-windows-msvc`; `ARM64` maps to
  `aarch64-pc-windows-msvc`.

First-time use in a local terminal on the Bridge host:

```powershell
# 1. Install a global Codex package so the native binary is vendored.
npm install -g @openai/codex

# 2. Build codex-switch 0.3.2 and copy it into the user bin directory.
cd <runtime-switch-checkout>
$env:RUSTFLAGS = '-A dead_code'
cargo build --release
Copy-Item .\target\release\codex-switch.exe "$env:USERPROFILE\.cargo\bin\codex-switch.exe"

# 3. Log in locally; browser OAuth cannot run through Feishu.
codex-switch login personal

# 4. Launch Codex through the managed runtime from any project directory.
powershell -NoProfile -ExecutionPolicy Bypass -File <bridge>\scripts\codex-managed.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File <bridge>\scripts\codex-managed.ps1 resume
```

Why the build flag: upstream `codex-switch` 0.3.2 sets
`[lints.rust] warnings = "deny"`. With current stable Rust toolchains the
Windows build can fail on `dead_code`, so `RUSTFLAGS=-A dead_code` suppresses
only that lint for the build. Do not blanket-disable warnings, and
regenerate/review the binary after upgrading Rust or codex-switch.

The launcher uses PowerShell's call operator (`&`), not `Start-Process`. It
stays in the foreground, keeps the caller's working directory and stdio, passes
each forwarded argument as a separate array element (including `--` and leading
dashes), and returns the `codex-switch` exit code. No shell wrapper or `.cmd`
shim is required: the real `codex-switch.exe` is invoked directly.

## Managed launch and existing processes

Bridge commands only update the codex-switch store/Codex auth file. For
in-session hot-loading, start Codex through the managed launcher in a local
terminal:

```sh
codex-switch run
codex-switch run -- resume
```

`codex-switch run` starts `codex app-server`, proxies the TUI and can hot-load
the selected ChatGPT OAuth account into that managed session.

An already-running interactive Codex/TUI is **not** adopted. `codex-switch
switch` refuses while it detects active unmanaged Codex processes; the Bridge
does not close them for you. Close or finish those sessions yourself, then send
`/runtime switch` again. The Bridge also does not convert an existing process
into a managed one.

The Bridge's own background app-server processes are treated differently from
interactive sessions by codex-switch, but detection depends on the host OS and
process tree. If the command reports active Codex processes, treat that as a
refusal, not as an invitation for the Bridge to kill anything.

## Windows compatibility

- Use the same Node.js runtime the private edition already requires (Node 24+).
- Put `codex-switch.exe` on `PATH`, or set `CODEX_SWITCH_BIN` to its absolute
  path. The Bridge invokes it with `shell: false` and `windowsHide: true`, so
  paths with spaces are safe and no console window should flash.
- npm/`.cmd` shims are handled by the existing cross-platform spawn helper.
- The CLI's process check uses PowerShell. Expect a short delay on some hosts;
  the Bridge enforces a bounded timeout and never retries.
- OAuth login remains a local-terminal step. Do not route login/import/export
  through Feishu.

## What a successful switch does and does not mean

A zero exit code means the local command completed. The Bridge reports:

- “切换命令已完成” (command completed);
- “运行身份尚未独立核验” (runtime identity was **not** independently verified);
- it never claims “所有终端已切换” (all terminals switched).

For a managed session, a successful switch is picked up by the next turn. An
in-flight request may keep the auth it started with and can fail with a usage
limit; this entry does not retry it and does not restart the daemon. Other
unmanaged terminals keep their old auth until they are restarted or switched
by their own explicit action.

`/runtime status` reads the account store/auth marker. It also does not prove
what every open terminal is currently using.

## Error behavior

The runner makes exactly one spawn attempt per switch. Failures are mapped to
safe Chinese messages without raw stderr:

| Code | Meaning |
| --- | --- |
| `not_found` | Executable missing or not executable |
| `timeout` | Bounded timeout reached; command killed and close confirmed, result unconfirmed |
| `failed` | Non-zero exit; no retry |
| `output_too_large` | Output exceeded 64 KiB; command killed and close confirmed |
| `invalid_output` | JSON did not match schema version 1 / expected command |
| `invalid_alias` | Selector failed the strict allow-list |
| `busy` | Existing account transition lock is held (including `/account`) |
| `cleanup_required` | Killed process did not confirm close; later switches are refused until the Bridge is restarted |
| `spawn_failed` | Process could not be started |

A switch is single-flight and shares the existing account transition lock, so a
runtime switch and a CC Switch `/account` action cannot overlap. Do not send a
new task while the “正在执行” acknowledgment is still outstanding.

On timeout or oversized output the runner kills the child and waits a bounded
time for the OS `close` event **before** releasing the transition lock. If close
cannot be confirmed, the runner does not permit another switch (which could
become a second writer against the account store): it returns the safe
`cleanup_required` error and keeps refusing later switches. Confirm locally that
`codex-switch` has exited, then restart the Bridge to clear the latch.
