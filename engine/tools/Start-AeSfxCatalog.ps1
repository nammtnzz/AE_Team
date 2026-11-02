[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[A-Za-z0-9-]{8,80}$')]
    [string]$RequestId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$requestPath = Join-Path $workspaceRoot ".ae-codex/library/requests/sfx-$RequestId.json"
if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) { throw 'SFX request does not exist.' }
$helperPath = Join-Path $PSScriptRoot 'Update-AeSfxCatalog.ps1'
$powerShellPath = (Get-Process -Id $PID).Path
if ([IO.Path]::GetFileName($powerShellPath) -ne 'pwsh.exe' -or $helperPath.Contains('"')) { throw 'Invalid helper runtime path.' }
# All variable command values are either an absolute quoted workspace path or a restricted ID.
$arguments = @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', ('"' + $helperPath + '"'), '-RequestId', $RequestId)
$process = Start-Process -FilePath $powerShellPath -ArgumentList $arguments -WindowStyle Hidden -PassThru
$ackPath = Join-Path $workspaceRoot ".ae-codex/library/requests/launch-sfx-$RequestId.json"
$ackTemp = "$ackPath.tmp-$([guid]::NewGuid().ToString('N'))"
try {
    $ack = @{schemaVersion=1;requestId=$RequestId;state='launched';processId=$process.Id}
    [IO.File]::WriteAllText($ackTemp, ($ack | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($ackTemp, $ackPath, $false)
} finally { if (Test-Path -LiteralPath $ackTemp) { Remove-Item -LiteralPath $ackTemp } }
"CODEX_SFX_LAUNCHED $($process.Id)"
