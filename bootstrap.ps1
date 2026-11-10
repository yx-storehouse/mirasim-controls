[CmdletBinding()]
param(
    [ValidateSet('install', 'status', 'restore', 'diagnose')]
    [string]$Action = 'install',
    [string]$RepositoryUrl = 'https://github.com/yx-storehouse/mirasim-controls.git',
    [string]$Branch = 'main',
    [string]$CacheRoot = '',
    [switch]$Offline,
    [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Throw-UpdateError {
    param([string]$Message, [int]$ExitCode = 10)
    $problem = New-Object System.InvalidOperationException($Message)
    $problem.Data['BootstrapExitCode'] = $ExitCode
    throw $problem
}

function ConvertTo-ProcessArgument {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { $Value = '' }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-UpdateProcess {
    param(
        [string]$FilePath,
        [AllowEmptyString()][string[]]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$Environment = @{},
        [int]$TimeoutSeconds = 45,
        [switch]$StreamOutput
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = (@($Arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' ')
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    # Caller Git variables must not redirect this owned bare repository.
    foreach ($key in @('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ASKPASS', 'SSH_ASKPASS')) {
        $info.EnvironmentVariables.Remove($key)
    }
    foreach ($key in $Environment.Keys) { $info.EnvironmentVariables[$key] = [string]$Environment[$key] }
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $info
    $output = New-Object 'System.Collections.Generic.List[string]'
    $errors = New-Object 'System.Collections.Generic.List[string]'
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $null = $child.Start()
        $stdout = $child.StandardOutput.ReadLineAsync()
        $stderr = $child.StandardError.ReadLineAsync()
        $outEnded = $false
        $errEnded = $false
        while (-not $outEnded -or -not $errEnded -or -not $child.HasExited) {
            if ($TimeoutSeconds -gt 0 -and $watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                if (-not $child.HasExited) { $child.Kill() }
                $null = $child.WaitForExit(2000)
                Throw-UpdateError '更新检查超时，请检查网络后重试。'
            }
            if (-not $outEnded -and $stdout.IsCompleted) {
                $line = $stdout.GetAwaiter().GetResult()
                if ($null -eq $line) { $outEnded = $true }
                else {
                    $output.Add($line)
                    if ($StreamOutput) { Write-Host $line }
                    $stdout = $child.StandardOutput.ReadLineAsync()
                }
            }
            if (-not $errEnded -and $stderr.IsCompleted) {
                $line = $stderr.GetAwaiter().GetResult()
                if ($null -eq $line) { $errEnded = $true }
                else {
                    $errors.Add($line)
                    if ($StreamOutput) { Write-Host $line -ForegroundColor Red }
                    $stderr = $child.StandardError.ReadLineAsync()
                }
            }
            if (-not $outEnded -or -not $errEnded -or -not $child.HasExited) { [System.Threading.Thread]::Sleep(15) }
        }
        $child.WaitForExit()
        return [pscustomobject]@{ ExitCode = [int]$child.ExitCode; Stdout = ($output -join "`n"); Stderr = ($errors -join "`n") }
    }
    finally { $watch.Stop(); $child.Dispose() }
}

function Assert-NoReparsePath {
    param([string]$Path)
    $probe = [System.IO.Path]::GetFullPath($Path)
    while ($probe) {
        if (Test-Path -LiteralPath $probe) {
            $item = Get-Item -LiteralPath $probe -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-UpdateError '缓存路径包含符号链接或目录联接，已停止操作。'
            }
        }
        $parent = [System.IO.Directory]::GetParent($probe)
        if ($null -eq $parent) { break }
        $probe = $parent.FullName
    }
}

function Get-OwnedPath {
    param([string]$Root, [string]$Relative)
    $absoluteRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char]'\', [char]'/')
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $absoluteRoot $Relative))
    if (-not $candidate.StartsWith($absoluteRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        Throw-UpdateError '路径超出了本工具缓存目录。'
    }
    Assert-NoReparsePath $candidate
    return $candidate
}

function Test-ReleaseRelativePath {
    param([string]$Path, [switch]$AllowDirectory)
    if (-not $Path -or $Path.Length -gt 220 -or $Path.Contains('\') -or $Path.Contains(':')) { return $false }
    $candidate = if ($AllowDirectory) { $Path.TrimEnd('/') } else { $Path }
    if ($candidate -eq 'release.json') { return -not $AllowDirectory }
    if ($candidate -eq 'runtime') { return [bool]$AllowDirectory }
    if (-not $candidate.StartsWith('runtime/', [System.StringComparison]::Ordinal)) { return $false }
    foreach ($part in $candidate.Split('/')) {
        if ($part -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $part.EndsWith('.') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { return $false }
    }
    return $true
}

function Get-ReleaseTreeFiles {
    param([string]$Root)
    $pending = New-Object 'System.Collections.Generic.Queue[string]'
    $pending.Enqueue($Root)
    $count = 0
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        Assert-NoReparsePath $directory
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            $count++
            if ($count -gt 512) { Throw-UpdateError '发布文件数量超过限制。' }
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Throw-UpdateError '发布文件包含符号链接或目录联接。' }
            if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
            else { $item.FullName }
        }
    }
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-Release {
    param([string]$Root, [string]$ExpectedManifestHash = '')
    Assert-NoReparsePath $Root
    $manifestPath = Get-OwnedPath $Root 'release.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or (Get-Item -LiteralPath $manifestPath).Length -gt 1048576) { Throw-UpdateError '缺少有效的发布清单 release.json。' 12 }
    $manifestHash = Get-FileSha256 $manifestPath
    if ($ExpectedManifestHash -and $manifestHash -ne $ExpectedManifestHash) { Throw-UpdateError '缓存发布清单校验失败，已停止执行。' 12 }
    try { $manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { Throw-UpdateError '发布清单不是有效 JSON。' 12 }
    if ($null -eq $manifest -or $manifest -isnot [pscustomobject] -or -not $manifest.PSObject.Properties['schemaVersion'] -or $manifest.schemaVersion -ne 1) {
        Throw-UpdateError '发布清单协议不兼容，请更新固定启动器。' 12
    }
    if (-not $manifest.PSObject.Properties['version'] -or $manifest.version -isnot [string] -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$' -or $manifest.version.Length -gt 64) { Throw-UpdateError '发布版本号无效。' 12 }
    if (-not $manifest.PSObject.Properties['files'] -or $manifest.files -isnot [array] -or $manifest.files.Count -lt 2 -or $manifest.files.Count -gt 128) { Throw-UpdateError '发布文件清单无效。' 12 }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $manifest.files) {
        if ($null -eq $entry -or $entry -isnot [pscustomobject] -or -not $entry.PSObject.Properties['path'] -or -not $entry.PSObject.Properties['sha256'] -or $entry.path -isnot [string] -or $entry.sha256 -isnot [string]) { Throw-UpdateError '发布文件条目无效。' 12 }
        if (-not (Test-ReleaseRelativePath $entry.path) -or -not $entry.path.StartsWith('runtime/') -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or -not $seen.Add($entry.path)) { Throw-UpdateError '发布文件路径、哈希或重复条目无效。' 12 }
        $file = Get-OwnedPath $Root $entry.path
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -gt 16777216 -or (Get-FileSha256 $file) -ne $entry.sha256.ToLowerInvariant()) {
            Throw-UpdateError ('发布文件校验失败：' + $entry.path) 12
        }
    }
    if (-not $seen.Contains('runtime/run.ps1') -or -not $seen.Contains('runtime/main.cjs')) { Throw-UpdateError '发布清单缺少运行入口。' 12 }
    $base = [System.IO.Path]::GetFullPath($Root).TrimEnd([char]'\', [char]'/') + [System.IO.Path]::DirectorySeparatorChar
    foreach ($file in @(Get-ReleaseTreeFiles $Root)) {
        $relative = $file.Substring($base.Length).Replace('\', '/')
        if ($relative -ne 'release.json' -and -not $seen.Contains($relative)) { Throw-UpdateError ('发布目录存在未登记文件：' + $relative) 12 }
    }
    $parseTokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Root 'runtime/run.ps1'), [ref]$parseTokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { Throw-UpdateError '运行入口 PowerShell 语法校验失败。' 12 }
    return [pscustomobject]@{ Root = $Root; Version = $manifest.version; ManifestHash = $manifestHash }
}

function Expand-ReleaseArchive {
    param([string]$Archive, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        [long]$total = 0
        if ($zip.Entries.Count -gt 512) { Throw-UpdateError '发布压缩包文件数量超过限制。' 12 }
        foreach ($entry in $zip.Entries) {
            $isDirectory = $entry.FullName.EndsWith('/')
            if (-not (Test-ReleaseRelativePath $entry.FullName -AllowDirectory:$isDirectory) -or -not $seen.Add($entry.FullName.TrimEnd('/'))) { Throw-UpdateError '发布压缩包包含不安全或重复路径。' 12 }
            $mode = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if ($mode -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0) { Throw-UpdateError '发布压缩包包含符号链接。' 12 }
            $total += $entry.Length
            if ($entry.Length -gt 16777216 -or $total -gt 67108864) { Throw-UpdateError '发布压缩包大小超过限制。' 12 }
        }
    }
    finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
}

function Remove-OwnedStaging {
    param([string]$StagingRoot, [string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    $absoluteRoot = [System.IO.Path]::GetFullPath($StagingRoot).TrimEnd([char]'\', [char]'/')
    $absolutePath = [System.IO.Path]::GetFullPath($Path)
    if ([System.IO.Path]::GetDirectoryName($absolutePath) -ne $absoluteRoot -or [System.IO.Path]::GetFileName($absolutePath) -notmatch '^[a-f0-9]{32}(?:\.zip)?$') { Throw-UpdateError '拒绝清理非临时发布路径。' }
    Assert-NoReparsePath $absolutePath
    if (Test-Path -LiteralPath $absolutePath -PathType Container) { $null = @(Get-ReleaseTreeFiles $absolutePath) }
    Remove-Item -LiteralPath $absolutePath -Force -Recurse
}

function Read-CurrentState {
    param([string]$Root, [string]$Repository, [string]$Ref)
    $path = Get-OwnedPath $Root 'current.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { $state = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { Throw-UpdateError '本地版本记录损坏，已停止执行。' 12 }
    foreach ($key in @('schemaVersion', 'repositoryUrl', 'branch', 'commit', 'version', 'manifestSha256')) {
        if ($null -eq $state -or $state -isnot [pscustomobject] -or -not $state.PSObject.Properties[$key]) { Throw-UpdateError '本地版本记录缺少必要字段。' 12 }
    }
    if ($state.schemaVersion -ne 1 -or $state.commit -isnot [string] -or $state.commit -notmatch '^[a-f0-9]{40}$' -or $state.manifestSha256 -isnot [string] -or $state.manifestSha256 -notmatch '^[a-f0-9]{64}$') { Throw-UpdateError '本地版本记录格式无效。' 12 }
    if ($state.repositoryUrl -ne $Repository -or $state.branch -ne $Ref) { Throw-UpdateError '此缓存属于其他仓库或分支，请使用独立缓存目录。' 12 }
    return $state
}

function Resolve-CachedRelease {
    param([string]$Root, $State)
    if ($null -eq $State) { Throw-UpdateError '没有已校验的本地版本。请联网后重试；私有仓库需先运行 gh auth login。' }
    $path = Get-OwnedPath $Root ('releases/' + $State.commit)
    $release = Test-Release $path $State.manifestSha256
    if ($release.Version -ne $State.version) { Throw-UpdateError '缓存版本与发布清单不一致。' 12 }
    return $release
}

function Write-CurrentState {
    param([string]$Root, $State)
    $destination = Get-OwnedPath $Root 'current.json'
    $temporary = Get-OwnedPath $Root ('current-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($temporary, (($State | ConvertTo-Json -Depth 4) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $destination) { [System.IO.File]::Replace($temporary, $destination, [NullString]::Value) }
        else { [System.IO.File]::Move($temporary, $destination) }
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Invoke-ManagedGit {
    param([string]$Git, [string]$Root, [string[]]$Arguments, [switch]$NoRepository)
    # Archive bytes must match the committed manifest, independent of a user's
    # global Windows line-ending or attributes preferences.
    $gitArguments = @('-c', 'core.hooksPath=NUL', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.attributesFile=NUL', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=30')
    if (Get-Command gh.exe -CommandType Application -ErrorAction SilentlyContinue) { $gitArguments += @('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential') }
    if (-not $NoRepository) { $gitArguments += @('--git-dir', (Get-OwnedPath $Root 'repository.git')) }
    $result = Invoke-UpdateProcess -FilePath $Git -Arguments ($gitArguments + $Arguments) -WorkingDirectory $Root -Environment @{ GIT_TERMINAL_PROMPT = '0'; GCM_INTERACTIVE = 'Never'; GIT_OPTIONAL_LOCKS = '0' }
    if ($result.ExitCode -ne 0) {
        $detail = $result.Stderr
        if ($detail.Length -gt 1500) { $detail = $detail.Substring(0, 1500) }
        Throw-UpdateError ('Git 更新失败：' + $detail.Trim())
    }
    return $result.Stdout.Trim()
}

function Get-RemoteCommit {
    param([string]$Root, [string]$Repository, [string]$Ref)
    $command = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { Throw-UpdateError '找不到 Git for Windows，请安装 Git 后重试。' }
    $git = $command.Source
    $null = Invoke-ManagedGit $git $Root @('check-ref-format', ('refs/heads/' + $Ref)) -NoRepository
    $bare = Get-OwnedPath $Root 'repository.git'
    if (-not (Test-Path -LiteralPath $bare)) {
        $null = Invoke-ManagedGit $git $Root @('init', '--bare', $bare) -NoRepository
    }
    $isBare = Invoke-ManagedGit $git $Root @('rev-parse', '--is-bare-repository')
    if ($isBare -ne 'true') { Throw-UpdateError 'Git 缓存不是独立裸仓库，已停止更新。' }
    # A first run may have stopped between init and remote add; completing that
    # initialization is safe, but an existing different origin is never changed.
    $remotes = Invoke-ManagedGit $git $Root @('remote')
    if (@($remotes -split "\r?\n") -cnotcontains 'origin') {
        $refs = Invoke-ManagedGit $git $Root @('for-each-ref', '--format=%(refname)')
        if ($remotes -or $refs) { Throw-UpdateError 'Git 缓存缺少 origin 但已有其他内容，已停止自动接管。' }
        $null = Invoke-ManagedGit $git $Root @('remote', 'add', 'origin', $Repository)
    }
    $actualOrigin = Invoke-ManagedGit $git $Root @('remote', 'get-url', 'origin')
    if ($actualOrigin -ne $Repository) { Throw-UpdateError 'Git 缓存来源与固定仓库不一致，已停止更新。' }
    $null = Invoke-ManagedGit $git $Root @('fetch', '--no-tags', 'origin', ('+refs/heads/' + $Ref + ':refs/remotes/origin/' + $Ref))
    $commit = Invoke-ManagedGit $git $Root @('rev-parse', '--verify', ('refs/remotes/origin/' + $Ref + '^{commit}'))
    if ($commit -notmatch '^[a-f0-9]{40}$') { Throw-UpdateError 'Git 未返回有效提交编号。' }
    return [pscustomobject]@{ Git = $git; Commit = $commit }
}

function Update-Release {
    param([string]$Root, [string]$Repository, [string]$Ref, $Current, $Remote)
    if ($null -ne $Current -and $Current.commit -eq $Remote.Commit) {
        $release = Resolve-CachedRelease $Root $Current
        Write-Host ('补丁脚本已是最新：{0} / {1}' -f $release.Version, $Remote.Commit.Substring(0, 12)) -ForegroundColor Green
        return $release
    }
    $stagingRoot = Get-OwnedPath $Root 'staging'
    $null = New-Item -ItemType Directory -Path $stagingRoot -Force
    $id = [Guid]::NewGuid().ToString('N')
    $archive = Get-OwnedPath $stagingRoot ($id + '.zip')
    $stage = Get-OwnedPath $stagingRoot $id
    try {
        $null = Invoke-ManagedGit $Remote.Git $Root @('archive', '--format=zip', ('--output=' + $archive), $Remote.Commit, 'release.json', 'runtime')
        Expand-ReleaseArchive $archive $stage
        $candidate = Test-Release $stage
        $destination = Get-OwnedPath $Root ('releases/' + $Remote.Commit)
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force
        if (Test-Path -LiteralPath $destination) { $candidate = Test-Release $destination $candidate.ManifestHash }
        else { [System.IO.Directory]::Move($stage, $destination); $candidate.Root = $destination }
        $state = [pscustomobject]@{ schemaVersion = 1; repositoryUrl = $Repository; branch = $Ref; commit = $Remote.Commit; version = $candidate.Version; manifestSha256 = $candidate.ManifestHash }
        Write-CurrentState $Root $state
        Write-Host ('已更新并校验补丁脚本：{0} / {1}' -f $candidate.Version, $Remote.Commit.Substring(0, 12)) -ForegroundColor Green
        return $candidate
    }
    finally {
        Remove-OwnedStaging $stagingRoot $archive
        Remove-OwnedStaging $stagingRoot $stage
    }
}

function Start-ControlsBootstrap {
    param([string]$Root, [string]$Repository, [string]$Ref, [string]$RequestedAction, [bool]$UseOffline)
    if (-not $Repository -or $Repository.IndexOfAny([char[]]"`r`n") -ge 0 -or $Repository.StartsWith('-')) { Throw-UpdateError '仓库地址无效。' }
    if (-not [System.IO.Path]::IsPathRooted($Repository)) {
        $uri = $null
        if (-not [Uri]::TryCreate($Repository, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo) { Throw-UpdateError '仓库必须是 HTTPS 地址或本地绝对路径。' }
    }
    if (-not $Ref -or $Ref -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $Ref.Contains('..') -or $Ref.Contains('//') -or $Ref.EndsWith('/') -or $Ref.EndsWith('.')) { Throw-UpdateError '分支名称无效。' }
    $rootPath = [System.IO.Path]::GetFullPath($Root)
    Assert-NoReparsePath $rootPath
    $null = New-Item -ItemType Directory -Path $rootPath -Force
    $lockPath = Get-OwnedPath $rootPath 'update.lock'
    $lock = $null
    try {
        try { $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
        catch { Throw-UpdateError '另一个控制区操作正在运行，请等它完成后重试。' 11 }
        $current = Read-CurrentState $rootPath $Repository $Ref
        if ($UseOffline) {
            $release = Resolve-CachedRelease $rootPath $current
            Write-Host ('离线使用已校验版本：{0} / {1}' -f $release.Version, $current.commit.Substring(0, 12)) -ForegroundColor Yellow
        }
        else {
            Write-Host ('正在检查 Git 仓库最新脚本（{0}）…' -f $Ref)
            $remote = $null
            try { $remote = Get-RemoteCommit $rootPath $Repository $Ref }
            catch {
                if ($null -eq $current) { throw }
                Write-Host ('未能检查更新：' + $_.Exception.Message) -ForegroundColor Yellow
                $release = Resolve-CachedRelease $rootPath $current
                Write-Host ('使用已校验的本地缓存，无法确认它是最新版本：{0} / {1}' -f $release.Version, $current.commit.Substring(0, 12)) -ForegroundColor Yellow
            }
            if ($null -ne $remote) { $release = Update-Release $rootPath $Repository $Ref $current $remote }
        }
        Write-Host ''
        $runtime = Get-OwnedPath $release.Root 'runtime/run.ps1'
        $diagnostics = Get-OwnedPath $rootPath 'diagnostics'
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $result = Invoke-UpdateProcess -FilePath $powershell -Arguments @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runtime, '-Action', $RequestedAction, '-NonInteractive') -WorkingDirectory (Split-Path -Parent $runtime) -Environment @{ MIRASIM_CONTROLS_DIAGNOSTICS = $diagnostics } -TimeoutSeconds 0 -StreamOutput
        return $result.ExitCode
    }
    finally { if ($null -ne $lock) { $lock.Dispose() } }
}

# Dot-sourcing is supported for read-only helper tests, without updating or installing.
if ($MyInvocation.InvocationName -ne '.') {
    $bootstrapExitCode = 10
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [Console]::OutputEncoding = $utf8
        $OutputEncoding = $utf8
        if (-not $CacheRoot) {
            if (-not $env:LOCALAPPDATA) { Throw-UpdateError '找不到 LOCALAPPDATA，请指定 CacheRoot。' }
            $CacheRoot = Join-Path $env:LOCALAPPDATA 'MirasimControls'
        }
        Write-Host 'Mirasim 控制区 · Git 自动更新启动器' -ForegroundColor Cyan
        $bootstrapExitCode = Start-ControlsBootstrap $CacheRoot $RepositoryUrl $Branch $Action ([bool]$Offline)
    }
    catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        if ($_.Exception.Data.Contains('BootstrapExitCode')) { $bootstrapExitCode = [int]$_.Exception.Data['BootstrapExitCode'] }
    }
    finally {
        if (-not $NonInteractive) { Write-Host ''; try { $null = Read-Host '按 Enter 关闭此窗口' } catch { } }
    }
    exit $bootstrapExitCode
}
