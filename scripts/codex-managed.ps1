# codex-managed.ps1 — start Codex through the local codex-switch runtime.
#
# Why this launcher exists: the Windows `codex` command on PATH is often a thin
# npm shim (codex.exe -> node codex.js) rather than the native binary. The
# vendored native binary lives inside the @openai/codex npm package and is a
# stable path, so resolve it explicitly and hand it to codex-switch:
#
#   codex-switch run --codex-bin <resolved native codex.exe> -- <your args>
#
# This script deliberately uses the call operator (`&`) instead of
# Start-Process: it must stay in the foreground, inherit the caller's working
# directory and stdio, and forward the exit code. Arguments are passed as one
# PowerShell array so spaces and leading dashes are not re-parsed.
#
# Overrides:
#   CODEX_SWITCH_BIN  absolute path to codex-switch.exe
#   CODEX_NATIVE_BIN  absolute path to the native codex.exe (skips npm lookup)
#
# No param block: every argument belongs to Codex, including `--` and `-h`.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-SwitchBin {
    $override = $env:CODEX_SWITCH_BIN
    if ($override) {
        if (-not (Test-Path -LiteralPath $override -PathType Leaf)) {
            throw "CODEX_SWITCH_BIN 指向的文件不存在：$override"
        }
        return (Resolve-Path -LiteralPath $override).ProviderPath
    }

    $homeDir = [Environment]::GetFolderPath('UserProfile')
    $candidates = @(
        (Join-Path $homeDir '.cargo\bin\codex-switch.exe'),
        (Join-Path $homeDir '.cargo\bin\codex-switch')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    throw "未找到 codex-switch.exe。请把它放到 $homeDir\.cargo\bin\，或用 CODEX_SWITCH_BIN 指定绝对路径。"
}

function Get-NpmRoots {
    # Prefix first: an explicit npm_config_prefix is also what the tests use.
    $roots = @()
    if ($env:npm_config_prefix) {
        $roots += (Join-Path $env:npm_config_prefix 'node_modules')
    }

    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) {
        $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    }
    if ($npmCommand) {
        try {
            $npmRoot = & $npmCommand.Source root -g 2>$null
            if ($LASTEXITCODE -eq 0 -and $npmRoot) {
                $roots += (($npmRoot | Select-Object -First 1).ToString().Trim())
            }
        } catch {
            # npm is optional; the well-known fallback below still applies.
        }
    }

    if ($env:APPDATA) {
        $roots += (Join-Path $env:APPDATA 'npm\node_modules')
    }

    return @($roots | Where-Object { $_ } | Select-Object -Unique)
}

function Resolve-NativeCodex {
    $override = $env:CODEX_NATIVE_BIN
    if ($override) {
        if (-not (Test-Path -LiteralPath $override -PathType Leaf)) {
            throw "CODEX_NATIVE_BIN 指向的文件不存在：$override"
        }
        return (Resolve-Path -LiteralPath $override).ProviderPath
    }

    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        $package = 'codex-win32-arm64'
        $target = 'aarch64-pc-windows-msvc'
    } else {
        $package = 'codex-win32-x64'
        $target = 'x86_64-pc-windows-msvc'
    }

    $roots = @(Get-NpmRoots)
    foreach ($root in $roots) {
        $codexPackage = Join-Path $root '@openai\codex'
        $candidates = @(
            # npm 0.166+ nests the platform package under @openai/codex.
            (Join-Path $codexPackage "node_modules\@openai\$package\vendor\$target\bin\codex.exe"),
            # Hoisted/deduped platform package next to @openai/codex.
            (Join-Path $root "@openai\$package\vendor\$target\bin\codex.exe"),
            # Older layouts that shipped vendor/ directly in @openai/codex.
            (Join-Path $codexPackage "vendor\$target\bin\codex.exe"),
            (Join-Path $codexPackage "vendor\$target\codex.exe"),
            (Join-Path $codexPackage "vendor\$target\codex\codex.exe")
        )
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return $candidate
            }
        }
    }

    throw "未找到 @openai/codex 自带的原生 codex.exe（架构 $($env:PROCESSOR_ARCHITECTURE)）。请先运行 npm install -g @openai/codex，或设置 CODEX_NATIVE_BIN 指向 codex.exe。已检查：$($roots -join ', ')"
}

try {
    $switchBin = Resolve-SwitchBin
    $nativeCodex = Resolve-NativeCodex

    # Keep the caller's cwd and stdio. `--` is required by codex-switch for
    # forwarded Codex arguments; array splatting preserves each argument.
    $forwarded = @('run', '--codex-bin', $nativeCodex, '--') + @($args)
    & $switchBin @forwarded
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("codex-managed: $($_.Exception.Message)")
    exit 1
}
