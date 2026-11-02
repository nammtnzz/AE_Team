#Requires -Version 7.0
<#
Installs or removes the AE_CodexTeam native bridge (.aex).
- The .aex goes to Adobe's shared plug-in folder (all AE versions load it). That folder is under
  Program Files, so only that copy/delete runs elevated (one UAC prompt).
- The AE_CodexTeam ScriptUI *Startup* loader is moved aside (backup kept) so it does not grab the runtime
  before the native bridge; the Window > AE_CodexTeam Bridge panel stays as a manual fallback.
- Codex AE files ("Codex Bridge") are never touched. After Effects must be closed.
#>
[CmdletBinding()]
param(
    [ValidateSet('Install','Uninstall','Status')][string]$Action = 'Status',
    [string]$Source = (Join-Path $PSScriptRoot 'out/AE_CodexTeam_Native.aex'),
    [string]$PluginRoot = 'C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore',
    [string]$AppDataRoot = ([Environment]::GetFolderPath('ApplicationData')),
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AE_CodexTeam'),
    # Tests only: redirected folders, no After Effects process check.
    [switch]$Fixture
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$target = Join-Path $PluginRoot 'AE_CodexTeam\AE_CodexTeam_Native.aex'
$backupRoot = Join-Path $InstallRoot '.ae-codex/setup/native-disabled-startup'

function Get-StartupLoaders {
    $base = Join-Path $AppDataRoot 'Adobe/After Effects'
    if (-not (Test-Path -LiteralPath $base)) { return @() }
    @(Get-ChildItem -LiteralPath $base -Directory | Where-Object Name -match '^\d+\.\d+$' | ForEach-Object {
        Join-Path $_.FullName 'Scripts/Startup/AE_CodexTeam Bridge Startup.jsx' } | Where-Object { Test-Path -LiteralPath $_ })
}
function Invoke-Elevated([string]$Command) {
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $Command -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "Lệnh cần quyền admin thất bại (exit $($p.ExitCode)): $Command" }
}
# Copy/delete directly when the folder is writable (fixtures, already-elevated runs); otherwise one UAC prompt.
function Invoke-Privileged([scriptblock]$Direct, [string]$ElevatedCommand) {
    try { & $Direct } catch { Invoke-Elevated $ElevatedCommand }
}
function Assert-AeClosed { if ($Fixture) { return }; if (Get-Process -Name AfterFX -ErrorAction SilentlyContinue) { throw 'Đóng After Effects trước khi cài/gỡ plugin native.' } }

$result = [ordered]@{ schema = 'ae-codexteam-native-install/v1'; action = $Action; plugin = $target }
if ($Action -eq 'Status') {
    $result.installed = Test-Path -LiteralPath $target
    $result.sha256 = if ($result.installed) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
    $result.scriptUiStartupLoaders = @(Get-StartupLoaders)
    $result.disabledStartupBackups = @(if (Test-Path -LiteralPath $backupRoot) { Get-ChildItem -LiteralPath $backupRoot -File | ForEach-Object FullName })
} elseif ($Action -eq 'Install') {
    Assert-AeClosed
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'installation.json'))) { throw 'Cài AE_CodexTeam (engine) trước: chạy AE_CodexTeam-Setup-1.3.0.exe.' }
    if (-not (Test-Path -LiteralPath $Source)) { throw "Không thấy plugin đã build: $Source" }
    $hash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant()
    $staged = Join-Path ([IO.Path]::GetTempPath()) ('aect-native-' + [guid]::NewGuid().ToString('N') + '.aex')
    Copy-Item -LiteralPath $Source -Destination $staged
    try {
        Invoke-Privileged { New-Item -ItemType Directory -Force -Path (Split-Path $target) -ErrorAction Stop | Out-Null; Copy-Item -LiteralPath $staged -Destination $target -Force -ErrorAction Stop } ('mkdir "' + (Split-Path $target) + '" 2>nul & copy /y "' + $staged + '" "' + $target + '"')
    }
    finally { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Plugin sau khi chép không khớp bản build.' }
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $moved = @()
    foreach ($loader in Get-StartupLoaders) {
        $version = Split-Path (Split-Path (Split-Path (Split-Path $loader))) -Leaf
        $backup = Join-Path $backupRoot ($version + '__AE_CodexTeam Bridge Startup.jsx')
        Move-Item -LiteralPath $loader -Destination $backup -Force
        $moved += $loader
    }
    $result.sha256 = $hash; $result.disabledScriptUiStartup = $moved
    $result.nextStep = 'Mở After Effects → Window → AE_CodexTeam Native Bridge (tự kết nối). Panel ScriptUI AE_CodexTeam Bridge vẫn dùng được nếu cần quay lại.'
} else {
    Assert-AeClosed
    if (Test-Path -LiteralPath $target) {
        Invoke-Privileged { Remove-Item -LiteralPath $target -Force -ErrorAction Stop; Remove-Item -LiteralPath (Split-Path $target) -ErrorAction SilentlyContinue } ('del /f /q "' + $target + '" & rmdir "' + (Split-Path $target) + '" 2>nul & exit /b 0')
    }
    $restored = @()
    if (Test-Path -LiteralPath $backupRoot) {
        foreach ($backup in Get-ChildItem -LiteralPath $backupRoot -File -Filter '*__AE_CodexTeam Bridge Startup.jsx') {
            $version = $backup.Name.Split('__')[0]
            $loader = Join-Path $AppDataRoot "Adobe/After Effects/$version/Scripts/Startup/AE_CodexTeam Bridge Startup.jsx"
            if (-not (Test-Path -LiteralPath $loader)) { Move-Item -LiteralPath $backup.FullName -Destination $loader; $restored += $loader }
        }
    }
    $result.removed = -not (Test-Path -LiteralPath $target); $result.restoredScriptUiStartup = $restored
}
$result | ConvertTo-Json -Depth 4
