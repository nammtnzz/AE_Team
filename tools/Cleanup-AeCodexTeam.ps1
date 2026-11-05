#Requires -Version 7.0
param([string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'AE_Team'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'TeamMaintenance.ps1')
$cleanupLock=$null
try {
    $InstallRoot=[IO.Path]::GetFullPath($InstallRoot); Assert-TeamPlainPath $InstallRoot
    $lockPath=Join-Path $InstallRoot '.ae-codex/setup/team-install.lock'; Assert-TeamPlainPath $lockPath
    # Serialize launch cleanup with installation before reading the active pointer.
    $cleanupLock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    Assert-TeamGuards ([Environment]::GetFolderPath('ApplicationData'))
    $meta=Read-TeamJson (Join-Path $InstallRoot 'installation.json')
    if(-not $meta.PSObject.Properties['product'] -or $meta.product -ne 'AE_CodexTeam'){throw 'Chưa cập nhật thành AE_CodexTeam; bản cũ được giữ'}
    Assert-TeamIdle $meta.runtimeRoot
    if($meta.mcpState -ne 'configured'){throw 'MCP chưa đăng ký xong; chưa dọn bản cũ'}
    Remove-TeamOldVersions $InstallRoot | ConvertTo-Json -Depth 6
}catch{[pscustomobject]@{state='deferred';reason=$_.Exception.Message} | ConvertTo-Json}
finally{if($cleanupLock){$cleanupLock.Dispose()}}
