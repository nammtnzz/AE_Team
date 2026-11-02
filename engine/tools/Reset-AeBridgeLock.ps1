[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,

    [switch]$IHaveVerifiedAfterEffectsIsIdle
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bridgeRoot = Join-Path $workspaceRoot '.ae-codex\bridge'
$lockPath = Join-Path $bridgeRoot 'submit.lock'
$ownerPath = Join-Path $lockPath 'owner.json'

if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) {
    throw "No active bridge lock owner was found at: $ownerPath"
}

$owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
if ($owner.runId -ne $RunId) {
    throw "Run ID does not match the active bridge lock. Active run ID: $($owner.runId)"
}

$hasTerminalStatus = $false
if (Test-Path -LiteralPath $owner.statusPath -PathType Leaf) {
    try {
        $status = Get-Content -LiteralPath $owner.statusPath -Raw | ConvertFrom-Json
        $hasTerminalStatus = $status.state -in @('success', 'error')
    } catch {
        $hasTerminalStatus = $false
    }
}

if (-not $hasTerminalStatus -and -not $IHaveVerifiedAfterEffectsIsIdle) {
    throw (
        'The bridge run has no terminal status. Verify in After Effects that the JSX is no longer running, ' +
        'then rerun with -IHaveVerifiedAfterEffectsIsIdle.'
    )
}

if ($IHaveVerifiedAfterEffectsIsIdle) {
    $jobPath = Join-Path $bridgeRoot ("inbox\job-$RunId.job")
    $runningPath = Join-Path $bridgeRoot ("inbox\job-$RunId.running")
    if (Test-Path -LiteralPath $jobPath -PathType Leaf) {
        Remove-Item -LiteralPath $jobPath -Force
    }
    if (Test-Path -LiteralPath $runningPath -PathType Leaf) {
        Remove-Item -LiteralPath $runningPath -Force
    }
}

Remove-Item -LiteralPath $ownerPath -Force
Remove-Item -LiteralPath $lockPath -Force
Write-Host "Cleared AE_CodexTeam Bridge lock for run: $RunId"

