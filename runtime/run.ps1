[CmdletBinding()]
param(
    [ValidateSet('install', 'status', 'restore', 'diagnose')]
    [string]$Action = 'install',
    [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Quote one argv element using the Windows CommandLineToArgvW/CRT rules.
# This path is also used on Windows PowerShell 5.1, whose ProcessStartInfo
# does not expose the newer ArgumentList collection.
function ConvertTo-LauncherArgument {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { $Value = '' }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function New-LauncherStartInfo {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [switch]$ElectronMode
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    $quoted = @($Arguments | ForEach-Object { ConvertTo-LauncherArgument $_ })
    $info.Arguments = $quoted -join ' '
    if ($ElectronMode) {
        # Change only this new process's environment, never the user's setting.
        $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
    }
    return $info
}

function Invoke-LauncherProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [switch]$ElectronMode,
        [int]$TimeoutMs = 0,
        [scriptblock]$OnOutput = { param($line) Write-Host $line },
        [scriptblock]$OnError = { param($line) Write-Host $line -ForegroundColor Red }
    )
    $info = New-LauncherStartInfo -FilePath $FilePath -Arguments $Arguments -WorkingDirectory $WorkingDirectory -ElectronMode:$ElectronMode
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadLineAsync()
        $stderr = $process.StandardError.ReadLineAsync()
        $stdoutEnded = $false
        $stderrEnded = $false
        while (-not $stdoutEnded -or -not $stderrEnded -or -not $process.HasExited) {
            if ($TimeoutMs -gt 0 -and $clock.ElapsedMilliseconds -ge $TimeoutMs) {
                if (-not $process.HasExited) { $process.Kill() }
                $null = $process.WaitForExit(2000)
                throw '运行环境检测超时。'
            }
            if (-not $stdoutEnded -and $stdout.IsCompleted) {
                $line = $stdout.GetAwaiter().GetResult()
                if ($null -eq $line) { $stdoutEnded = $true }
                else {
                    & $OnOutput $line
                    $stdout = $process.StandardOutput.ReadLineAsync()
                }
            }
            if (-not $stderrEnded -and $stderr.IsCompleted) {
                $line = $stderr.GetAwaiter().GetResult()
                if ($null -eq $line) { $stderrEnded = $true }
                else {
                    & $OnError $line
                    $stderr = $process.StandardError.ReadLineAsync()
                }
            }
            if (-not $stdoutEnded -or -not $stderrEnded -or -not $process.HasExited) {
                [System.Threading.Thread]::Sleep(15)
            }
        }
        $process.WaitForExit()
        return [int]$process.ExitCode
    }
    finally { $clock.Stop(); $process.Dispose() }
}

function Test-LauncherRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [switch]$ElectronMode
    )
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { return $null }
    $lines = New-Object 'System.Collections.Generic.List[string]'
    try {
        $result = Invoke-LauncherProcess -FilePath $FilePath -Arguments @('-e', "process.stdout.write('MIRASIM_SPEED_NODE::'+process.versions.node+'\n')") -WorkingDirectory $WorkingDirectory -ElectronMode:$ElectronMode -TimeoutMs 10000 -OnOutput { param($line) $lines.Add($line) } -OnError { param($line) }
        if ($result -ne 0) { return $null }
        foreach ($line in $lines) {
            if ($line -match '^MIRASIM_SPEED_NODE::(\d+)\.(\d+)\.(\d+)') {
                if ([int]$Matches[1] -lt 20) { return $null }
                return [pscustomobject]@{
                    Path = $FilePath
                    Version = ($Matches[1..3] -join '.')
                    ElectronMode = [bool]$ElectronMode
                }
            }
        }
    }
    catch { return $null }
    return $null
}

function Find-LauncherRuntime {
    param([Parameter(Mandatory = $true)][string]$WorkingDirectory)
    $nodeCandidates = New-Object 'System.Collections.Generic.List[string]'
    foreach ($command in @(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
        if ($command.Source) { $nodeCandidates.Add($command.Source) }
    }
    if ($env:ProgramFiles) { $nodeCandidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
    if ($env:LOCALAPPDATA) { $nodeCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')) }
    foreach ($candidate in @($nodeCandidates | Select-Object -Unique)) {
        $runtime = Test-LauncherRuntime -FilePath $candidate -WorkingDirectory $WorkingDirectory
        if ($null -ne $runtime) { return $runtime }
    }
    $electronCandidates = New-Object 'System.Collections.Generic.List[string]'
    if ($env:LOCALAPPDATA) {
        $electronCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\@mirasimdesktop\Mirasim.exe'))
        $electronCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Mirasim\Mirasim.exe'))
    }
    if ($env:ProgramFiles) { $electronCandidates.Add((Join-Path $env:ProgramFiles 'Mirasim\Mirasim.exe')) }
    foreach ($candidate in @($electronCandidates | Select-Object -Unique)) {
        $runtime = Test-LauncherRuntime -FilePath $candidate -WorkingDirectory $WorkingDirectory -ElectronMode
        if ($null -ne $runtime) { return $runtime }
    }
    throw '找不到可用的 Node.js 20+，Mirasim 内置运行环境也不可用。请先安装 Node.js 20 或更新版本，再重新双击运行。'
}

# Dot-sourcing loads helpers for the isolated launcher tests, without running a task.
if ($MyInvocation.InvocationName -ne '.') {
    $launcherExitCode = 2
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [Console]::OutputEncoding = $utf8
        $OutputEncoding = $utf8
        Write-Host 'Mirasim 控制区 · 安装与维护' -ForegroundColor Cyan
        Write-Host ''
        $main = Join-Path $PSScriptRoot 'main.cjs'
        if (-not (Test-Path -LiteralPath $main -PathType Leaf)) {
            throw '安装包不完整：缺少 main.cjs。请先将整个 ZIP 解压到同一个文件夹，再双击 BAT。'
        }
        $runtime = Find-LauncherRuntime -WorkingDirectory $PSScriptRoot
        $runtimeKind = if ($runtime.ElectronMode) { 'Mirasim 内置 Node' } else { 'Node.js' }
        Write-Host ('运行环境：{0} {1}' -f $runtimeKind, $runtime.Version)
        Write-Host ''
        # This wrapper owns the pause, so the JavaScript CLI always runs unattended.
        $launcherExitCode = Invoke-LauncherProcess -FilePath $runtime.Path -Arguments @($main, $Action, '--non-interactive') -WorkingDirectory $PSScriptRoot -ElectronMode:$runtime.ElectronMode
        if ($launcherExitCode -ne 0) {
            Write-Host ''
            Write-Host ('操作未完成，退出码：{0}。请查看上面的具体原因。' -f $launcherExitCode) -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        $launcherExitCode = 2
    }
    finally {
        if (-not $NonInteractive) {
            Write-Host ''
            try { $null = Read-Host '按 Enter 关闭此窗口' } catch { }
        }
    }
    exit $launcherExitCode
}
