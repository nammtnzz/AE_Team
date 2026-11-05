#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AE_CodexTeam'),
    [string]$AppDataRoot = ([Environment]::GetFolderPath('ApplicationData')),
    [string]$VersionFolder,
    [string]$LegacyRoot,
    # AE_CodexTeam <= 1.2.x installed into %LOCALAPPDATA%\CodexAE as "Codex Bridge"/ae_functions,
    # the same names Codex AE uses. That install is moved here and retired by its own uninstaller.
    [string]$LegacyInstallRoot,
    # Also install the native AEGP bridge (.aex) into Adobe's shared plug-in folder (one UAC prompt).
    [switch]$Native,
    [string]$PluginRoot = 'C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore',
    [string]$InstallerPath,
    [string]$ResultPath,
    [switch]$SkipTeam,
    # Claude skills folder for the bundled default image skill (iw-imagegen).
    [string]$ClaudeSkillsRoot,
    [switch]$Fixture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Unicode user/install paths must survive child PowerShell output on non-UTF-8 consoles.
$OutputEncoding = [Text.UTF8Encoding]::new($false); try { [Console]::OutputEncoding = $OutputEncoding } catch { }
. (Join-Path $PSScriptRoot 'TeamMaintenance.ps1')
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = [Text.UTF8Encoding]::new($false)
$engineInstalled = $false
$teamLock = $null
# Installs the bundled default image skill. Program files are refreshed (changed ones backed up first);
# the user's .env with gateway keys is never read, replaced or shipped; a missing .env starts from .env.example.
function Install-TeamSkill([string]$SkillsRoot) {
    $source = Join-Path $packageRoot 'skills/iw-imagegen'
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { return [ordered]@{state='not-bundled'} }
    $target = Join-Path $SkillsRoot 'iw-imagegen'
    Assert-TeamPlainPath $target
    $backup = Join-Path $target ('.ae-team-backup-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
    $updated = 0; $backedUp = 0
    foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
        $relative = [IO.Path]::GetRelativePath($source, $file.FullName)
        if ($relative -ieq '.env') { continue }
        $destination = Join-Path $target $relative
        if ([IO.File]::Exists($destination)) {
            if ((Get-FileHash -LiteralPath $destination).Hash -eq (Get-FileHash -LiteralPath $file.FullName).Hash) { continue }
            $saved = Join-Path $backup $relative; [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved)) | Out-Null
            [IO.File]::Copy($destination, $saved, $true); $backedUp++
        }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        [IO.File]::Copy($file.FullName, $destination, $true); $updated++
    }
    $envPath = Join-Path $target '.env'
    $envCreated = -not [IO.File]::Exists($envPath)
    if ($envCreated) { [IO.File]::Copy((Join-Path $target '.env.example'), $envPath, $false) }
    return [ordered]@{state='installed';path=$target;updated=$updated;backedUp=$backedUp;envCreated=$envCreated;needsKey=$envCreated}
}
function Copy-TeamInventory([string]$From,[string]$To) {
    if (-not $From -or $From -ieq $To -or -not (Test-Path -LiteralPath $From)) { return }
    Assert-TeamIdle $From
    $files = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in @('.ae-codex/library/config.json','.ae-codex/library/onboarding.json','.ae-codex/library/current.json','.ae-codex/library/latest-sfx.json','.ae-codex/plugins/effects-and-parameters.tsv','.ae-codex/plugins/effect-index.md')) {
        if (Test-Path -LiteralPath (Join-Path $From $file) -PathType Leaf) { [void]$files.Add($file) }
    }
    foreach ($file in @('.ae-codex/library/current.json','.ae-codex/library/latest-sfx.json')) {
        $full = Join-Path $From $file
        if (-not (Test-Path -LiteralPath $full)) { continue }
        $data = Read-TeamJson $full
        foreach ($prop in $data.PSObject.Properties) {
            if ($prop.Value -is [string] -and $prop.Name -match 'RelativePath$' -and $prop.Name -ne 'projectAudioRelativePath') {
                $relative = $prop.Value
                # A catalog may still point at a session file that was cleaned up; skip it instead of failing the install.
                if ($relative -match '^\.ae-codex/library/sessions/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+\.(jsonl|json|tsv)$' -and
                    (Test-Path -LiteralPath (Join-Path $From $relative) -PathType Leaf)) { [void]$files.Add($relative) }
            }
        }
    }
    foreach ($relative in $files) {
        $inputPath = [IO.Path]::GetFullPath((Join-Path $From $relative)); $outputPath = [IO.Path]::GetFullPath((Join-Path $To $relative))
        Assert-TeamPlainPath $inputPath; Assert-TeamPlainPath $outputPath
        if (-not (Test-TeamChild $inputPath $From) -or -not (Test-TeamChild $outputPath $To)) { throw 'Inventory path escaped its root' }
        if ((Get-Item -LiteralPath $inputPath).Length -gt 134217728) { throw 'Saved inventory exceeds 128 MiB; use manual refresh instead' }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
            [IO.File]::Copy($inputPath,$outputPath,$true)
    }
}
try {
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot); Assert-TeamPlainPath $InstallRoot
    if ($Fixture -and $AppDataRoot -ieq [Environment]::GetFolderPath('ApplicationData')) { throw 'Fixture mode requires redirected AE/VS Code settings' }
    $product = Read-TeamJson (Join-Path $packageRoot 'product.json')
    if ($product.schema -ne 'ae-codexteam-package/v1') { throw 'Invalid AE_CodexTeam package' }
    foreach ($file in $product.files) {
        if ($file.path -match '(^|/)\.{1,2}(/|$)|[:\\]' -or [IO.Path]::IsPathRooted($file.path)) { throw 'Unsafe package path' }
        $full = [IO.Path]::GetFullPath((Join-Path $packageRoot $file.path)); Assert-TeamPlainPath $full
        if (-not (Test-TeamChild $full $packageRoot) -or -not [IO.File]::Exists($full) -or (Get-Item -LiteralPath $full).Length -ne $file.bytes -or
            (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ine $file.sha256) { throw "Package checksum mismatch: $($file.path)" }
    }
    [IO.Directory]::CreateDirectory((Join-Path $InstallRoot '.ae-codex/setup')) | Out-Null
    $teamLock = [IO.File]::Open((Join-Path $InstallRoot '.ae-codex/setup/team-install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    Assert-TeamGuards $AppDataRoot
    $prior = $null; $metadataPath = Join-Path $InstallRoot 'installation.json'
    if (Test-Path -LiteralPath $metadataPath) {
        $prior = Read-TeamJson $metadataPath
        if ($prior.schema -notin @('aect-installation/v1','codex-ae-installation/v1') -or -not (Test-TeamChild $prior.runtimeRoot (Join-Path $InstallRoot 'versions'))) { throw 'Invalid prior installation' }
        Assert-TeamIdle $prior.runtimeRoot
    }
    $legacyInstall = $null
    $legacyCandidate = if ($LegacyInstallRoot) { [IO.Path]::GetFullPath($LegacyInstallRoot) } elseif (-not $Fixture) { Join-Path $env:LOCALAPPDATA 'CodexAE' } else { $null }
    if ($legacyCandidate -and $legacyCandidate -ine $InstallRoot -and (Test-Path -LiteralPath (Join-Path $legacyCandidate 'installation.json') -PathType Leaf)) {
        $legacyMeta = Read-TeamJson (Join-Path $legacyCandidate 'installation.json')
        # Only our own old install (product marker) is touched; a real Codex AE install has no such marker.
        if ($legacyMeta.schema -in @('aect-installation/v1','codex-ae-installation/v1') -and $legacyMeta.PSObject.Properties['product'] -and $legacyMeta.product -ceq 'AE_CodexTeam' -and
            -not ($legacyMeta.PSObject.Properties['state'] -and $legacyMeta.state -eq 'uninstalled') -and (Test-TeamChild $legacyMeta.runtimeRoot (Join-Path $legacyCandidate 'versions'))) {
            Assert-TeamIdle $legacyMeta.runtimeRoot
            $legacyInstall = [pscustomobject]@{root=$legacyCandidate;runtimeRoot=[IO.Path]::GetFullPath($legacyMeta.runtimeRoot);
                panelPath=[string]$legacyMeta.panelPath;startupPath=[string]$legacyMeta.startupPath}
        }
    }
    # Codex AE may already have taken over that folder (its installer rewrites installation.json and the
    # "Codex Bridge" loaders). Then nothing there is ours to remove; only our orphaned runtime is reused as the
    # catalog source and its old autostart entry is switched off. Our runtimes carry aect_library_search.
    $orphanRuntime = $null
    if (-not $legacyInstall -and $legacyCandidate -and $legacyCandidate -ine $InstallRoot -and (Test-Path -LiteralPath (Join-Path $legacyCandidate 'versions') -PathType Container)) {
        $orphanRuntime = Get-ChildItem -LiteralPath (Join-Path $legacyCandidate 'versions') -Directory | Where-Object {
            $manifest = Join-Path $_.FullName 'distribution.json'
            if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
            $m = Read-TeamJson $manifest
            $m.schema -in @('aect-distribution/v1','codex-ae-distribution/v1') -and $m.PSObject.Properties['additionalTools'] -and (@($m.additionalTools) -contains 'aect_library_search' -or @($m.additionalTools) -contains 'ae_library_search')
        } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName
        if ($orphanRuntime) { Assert-TeamIdle $orphanRuntime }
    }
    if (-not $LegacyRoot -and -not $legacyInstall -and -not $orphanRuntime -and (-not $prior -or -not $prior.PSObject.Properties['product']) -and -not $Fixture) {
        $candidate = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AE_Codex'
        if (Test-Path -LiteralPath (Join-Path $candidate '.ae-codex/library/config.json')) { $LegacyRoot = $candidate }
    }
    if ($LegacyRoot) { Assert-TeamIdle $LegacyRoot }
    $code = $null
    if (-not $Fixture) {
        if (-not $SkipTeam) {
            $code = Get-Command code -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $code) { throw 'Chưa có Visual Studio Code. Bỏ chọn extension VS Code để chỉ cài engine và panel AE.' }
        }
        $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $nodeVersion = & $node.Source -p 'process.versions.node'
        if ([version]$nodeVersion -lt [version]'20.0') { throw 'Cần Node.js 20 trở lên.' }
    }
    # Backend verifies and stages the engine, installs thin "AE_CodexTeam Bridge" loaders and registers only ae_codexteam.
    $pwsh = (Get-Process -Id $PID).Path
    $backendArgs = @('-NoProfile','-File',(Join-Path $packageRoot 'engine/tools/Install-AeDistribution.ps1'),'-InstallRoot',$InstallRoot,'-AppDataRoot',$AppDataRoot)
    if ($VersionFolder) { $backendArgs += @('-VersionFolder',$VersionFolder) }
    if ($Fixture) { $backendArgs += @('-SkipMcpRegistration','-SkipBackgroundService') }
    $backendText = & $pwsh @backendArgs
    if ($LASTEXITCODE -ne 0) { throw ($backendText -join "`n") }
    $backend = ($backendText -join "`n") | ConvertFrom-Json
    if ($backend.state -ne 'success') { throw 'Engine installation did not succeed' }
    $engineInstalled = $true
    $inventoryFrom = if ($LegacyRoot) { $LegacyRoot } elseif ($prior) { $prior.runtimeRoot } elseif ($legacyInstall) { $legacyInstall.runtimeRoot } elseif ($orphanRuntime) { $orphanRuntime } else { $null }
    Copy-TeamInventory $inventoryFrom $backend.runtimeRoot
    $teamState = 'skipped-fixture'
    if (-not $Fixture -and -not $SkipTeam) {
        $vsix = Join-Path $packageRoot $product.vsix
        [Console]::Error.WriteLine('Đang cập nhật extension AE_CodexTeam trong VS Code…')
        $codeOutput = & $code.Source --install-extension $vsix --force 2>&1
        if ($LASTEXITCODE -ne 0) { throw ('Không cài được extension. Engine đã cài; bản cũ được giữ. ' + ($codeOutput -join ' ')) }
        $extensions = & $code.Source --list-extensions --show-versions
        if ($LASTEXITCODE -ne 0 -or @($extensions) -notcontains ('inwave-local.p0-team@' + $product.version)) { throw 'Chưa xác minh được phiên bản extension; giữ nguyên các bản engine cũ.' }
        $teamState = 'installed'
    }
    if (-not $ClaudeSkillsRoot) { $ClaudeSkillsRoot = if ($Fixture) { Join-Path $InstallRoot 'fixture-claude-skills' } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude/skills' } }
    $skill = Install-TeamSkill $ClaudeSkillsRoot
    if (-not $Fixture) {
        if ($SkipTeam) { $teamState = 'skipped-user-choice' }
        if ($InstallerPath) {
            $appPath = Join-Path $InstallRoot 'AE_CodexTeam.exe'; Assert-TeamPlainPath $appPath
            if ([IO.Path]::GetFullPath($InstallerPath) -ine $appPath) {
                try { [IO.File]::Copy($InstallerPath,$appPath,$true) }
                catch { [Console]::Error.WriteLine('Launcher đang được mở. Engine và extension đã cập nhật; đóng launcher rồi mở bộ cài mới để sửa launcher.') }
            }
            $shell = New-Object -ComObject WScript.Shell
            $shortcutPath = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'AE_CodexTeam.lnk'
            $shortcut = $shell.CreateShortcut($shortcutPath); $shortcut.TargetPath=$appPath; $shortcut.WorkingDirectory=$InstallRoot; $shortcut.Save()
        }
    }
    $installedMetadata = Read-TeamJson $metadataPath
    $installedMetadata | Add-Member -NotePropertyName product -NotePropertyValue 'AE_CodexTeam' -Force
    $installedMetadata | Add-Member -NotePropertyName managerVersion -NotePropertyValue $product.version -Force
    $installedMetadata | Add-Member -NotePropertyName teamState -NotePropertyValue $teamState -Force
    if (-not $SkipTeam) { $installedMetadata | Add-Member -NotePropertyName teamVersion -NotePropertyValue $product.version -Force }
    elseif ($prior -and $prior.PSObject.Properties['teamVersion']) { $installedMetadata | Add-Member -NotePropertyName teamVersion -NotePropertyValue $prior.teamVersion -Force }
    [IO.File]::WriteAllText($metadataPath,($installedMetadata | ConvertTo-Json -Depth 6),$utf8)
    $cleanup = if ($Fixture -or $backend.mcpState -eq 'configured') { Remove-TeamOldVersions $InstallRoot -Fixture:$Fixture } else { @{removed=@();deferred=@('MCP registration needs repair; old versions preserved');preservedData=@()} }
    # Daily hidden retention: generated data and archives older than 10 days age out so disk use stays bounded.
    if (-not $Fixture) {
        $retention = Join-Path ([string]$installedMetadata.runtimeRoot) 'tools/Invoke-AeRetention.ps1'
        if ([IO.File]::Exists($retention)) { try { & $retention -Register -InstallRoot $InstallRoot -Days 10 | Out-Null } catch { } }
    }
    # Free the shared names (Codex Bridge loaders, ae_functions, CodexAE.Background) with the old runtime's own
    # verified uninstaller: it backs up program files and keeps all data. On failure the new install stays valid
    # and the next run retries; nothing AE-related is replayed.
    $legacyResult = $null
    if ($legacyInstall) {
        # The old uninstaller refuses to run from inside the install it removes, so run a verbatim copy of it
        # (plus the two helpers it loads from its own folder) from a temporary folder outside that install.
        $legacyTools = Join-Path ([IO.Path]::GetTempPath()) ('aect-legacy-' + [guid]::NewGuid().ToString('N'))
        try {
            foreach ($name in @('Uninstall-AeDistribution.ps1','AeBackgroundServiceLifecycle.ps1','AeCodexConfig.js')) {
                $source = Join-Path $legacyInstall.runtimeRoot ('tools/' + $name); Assert-TeamPlainPath $source
                if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Bản cũ thiếu $name." }
                [IO.Directory]::CreateDirectory((Join-Path $legacyTools 'tools')) | Out-Null
                [IO.File]::Copy($source,(Join-Path $legacyTools ('tools/' + $name)),$false)
            }
            $uninstaller = Join-Path $legacyTools 'tools/Uninstall-AeDistribution.ps1'
            $legacyText = & $pwsh -NoProfile -File $uninstaller -InstallRoot $legacyInstall.root -AppDataRoot $AppDataRoot 2>$null
            $legacyResult = ($legacyText -join "`n") | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0 -or $legacyResult.state -ne 'success') { throw [string]$legacyResult.error }
            # The 1.2.x uninstaller compares loaders with backslash paths while its installer wrote forward
            # slashes, so it keeps them. Remove only loaders that still load exactly that old runtime.
            $backupDir = Join-Path $InstallRoot '.ae-codex/setup/legacy-loaders'
            $bundle = (Join-Path $legacyInstall.runtimeRoot 'jsx/Codex Bridge.jsx')
            $removedLegacyLoaders = @()
            foreach ($loader in @($legacyInstall.panelPath,$legacyInstall.startupPath)) {
                if (-not $loader -or -not (Test-Path -LiteralPath $loader -PathType Leaf)) { continue }
                Assert-TeamPlainPath $loader
                $text = [IO.File]::ReadAllText($loader)
                $ours = $text.Contains((ConvertTo-Json -InputObject $bundle.Replace('\','/') -Compress -EscapeHandling EscapeNonAscii)) -or
                    $text.Contains((ConvertTo-Json -InputObject $bundle -Compress -EscapeHandling EscapeNonAscii))
                if (-not $ours) { continue }
                [IO.Directory]::CreateDirectory($backupDir) | Out-Null
                [IO.File]::Copy($loader,(Join-Path $backupDir ([guid]::NewGuid().ToString('N') + '-' + [IO.Path]::GetFileName($loader))),$false)
                [IO.File]::Delete($loader); $removedLegacyLoaders += $loader
            }
            $legacyResult | Add-Member -NotePropertyName removedLegacyLoaders -NotePropertyValue $removedLegacyLoaders -Force
        } catch {
            $legacyResult = [pscustomobject]@{state='deferred';error=$_.Exception.Message;installRoot=$legacyInstall.root}
            $warningList = @($backend.warnings) + ('Chưa gỡ được bản AE_CodexTeam cũ tại ' + $legacyInstall.root + ' (panel "Codex Bridge" và MCP ae_functions cũ vẫn còn): ' + $_.Exception.Message + ' Đóng panel Codex Bridge cũ hoặc AE, rồi chạy lại bộ cài.')
            $backend | Add-Member -NotePropertyName warnings -NotePropertyValue $warningList -Force
        } finally { if (Test-Path -LiteralPath $legacyTools) { Remove-Item -LiteralPath $legacyTools -Recurse -Force -ErrorAction SilentlyContinue } }
    }
    if ($orphanRuntime) {
        # Files stay untouched (Codex AE may manage that folder); only our old helper autostart is disabled.
        $legacyResult = [pscustomobject]@{state='orphan-runtime';runtimeRoot=$orphanRuntime;inventoryCopied=($inventoryFrom -eq $orphanRuntime);backgroundAutostart='skipped-fixture'}
        if (-not $Fixture) {
            try {
                $lifecycle = Join-Path $orphanRuntime 'tools/AeBackgroundServiceLifecycle.ps1'; Assert-TeamPlainPath $lifecycle
                $disabled = (& $pwsh -NoProfile -File $lifecycle -Action Disable -WorkspaceRoot $orphanRuntime 2>$null) -join "`n" | ConvertFrom-Json
                $legacyResult.backgroundAutostart = if ($disabled.state -eq 'success') { 'disabled' } else { 'unchanged' }
            } catch { $legacyResult.backgroundAutostart = 'unchanged: ' + $_.Exception.Message }
        }
    }
    # Native AEGP bridge: one UAC prompt for Adobe's shared plug-in folder. Never fails the engine install.
    $nativeResult = $null
    $nativeInstaller = Join-Path $packageRoot 'native/Install-NativePlugin.ps1'
    if (-not $Fixture -and (Test-Path -LiteralPath $nativeInstaller)) {
        try {
            if (Get-Process -Name AfterFX -ErrorAction SilentlyContinue) { throw 'After Effects đang mở; đóng AE rồi chạy lại bộ cài để cài plugin native.' }
            $nativeText = & $pwsh -NoProfile -File $nativeInstaller -Action Install -Source (Join-Path $packageRoot 'native/AE_CodexTeam_Native.aex') -InstallRoot $InstallRoot -AppDataRoot $AppDataRoot 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($nativeText -join ' ') }
            $nativeResult = ($nativeText -join "`n") | ConvertFrom-Json
        } catch {
            $nativeResult = [pscustomobject]@{state='skipped';error=$_.Exception.Message}
            $backend | Add-Member -NotePropertyName warnings -NotePropertyValue (@($backend.warnings) + ('Chưa cài plugin native: ' + $_.Exception.Message)) -Force
        }
    }
    $result = [ordered]@{schema='ae-codexteam-install/v1';state='success';imageSkill=$skill;version=$product.version;engineVersion=$backend.version;runtimeRoot=$backend.runtimeRoot;toolCount=$backend.toolCount;teamState=$teamState;cleanup=$cleanup;legacy=$legacyResult;native=$nativeResult;reloadRequired=$true;warnings=$backend.warnings;message='Đã cài AE_CodexTeam. Tải lại cửa sổ VS Code và MCP Codex; trong AE mở Window > AE_CodexTeam Bridge (khởi động lại AE nếu chưa thấy). Bấm Kiểm tra kết nối để xác nhận heartbeat mới.'}
} catch {
    $result = [ordered]@{schema='ae-codexteam-install/v1';state='error';engineInstalled=$engineInstalled;error=$_.Exception.Message;message='Không tự chạy lại tác vụ AE. Nếu engine đã cài, sửa bằng cùng bộ cài; bản cũ và dữ liệu vẫn được giữ.'}
}
if ($teamLock) { $teamLock.Dispose() }
$json = $result | ConvertTo-Json -Depth 8
if ($ResultPath) { [IO.File]::WriteAllText($ResultPath,$json,$utf8) }
$json
if ($result.state -ne 'success') { exit 1 }
