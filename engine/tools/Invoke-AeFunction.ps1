[CmdletBinding(DefaultParameterSetName = 'Function')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Function')][string]$Function,
    [Parameter(ParameterSetName = 'Function')][string]$ArgumentsJson = '{}',
    [Parameter(Mandatory = $true, ParameterSetName = 'Plan')][string]$Plan,
    [Parameter(Mandatory = $true, ParameterSetName = 'PlanJson')][string]$PlanJson,
    [Parameter(Mandatory = $true, ParameterSetName = 'List')][switch]$List,
    [Parameter(ParameterSetName = 'List')][string]$Search,
    [Parameter(ParameterSetName = 'List')][switch]$IncludeLegacy,
    [ValidateRange(5, 900)][int]$TimeoutSeconds = 180,
    [switch]$AsToolOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    if ($PSCmdlet.ParameterSetName -eq 'List') {
        & (Join-Path $PSScriptRoot 'Get-AeFunctions.ps1') -Search $Search -IncludeLegacy:$IncludeLegacy
        return
    }
    . (Join-Path $PSScriptRoot 'AeFunctionRequest.ps1')
    if ($PSCmdlet.ParameterSetName -eq 'Function') {
        try { $arguments = ConvertFrom-Json -InputObject $ArgumentsJson -AsHashtable -Depth 64 -ErrorAction Stop }
        catch { throw "Invalid -ArgumentsJson: $($_.Exception.Message)" }
        if ($arguments -isnot [System.Collections.IDictionary]) { throw '-ArgumentsJson must be a JSON object.' }
        $requestJson = [ordered]@{
            schema = 'aect-functions/v1'
            steps = @([ordered]@{ function = $Function; args = $arguments })
        } | ConvertTo-Json -Depth 64 -Compress
    } elseif ($PSCmdlet.ParameterSetName -eq 'Plan') {
        $planPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Plan)
        if (-not (Test-Path -LiteralPath $planPath -PathType Leaf)) { throw "Plan JSON file not found: $planPath" }
        if ((Get-Item -LiteralPath $planPath).Length -gt 131072) { throw 'Plan file exceeds 128 KiB.' }
        $requestJson = [System.IO.File]::ReadAllText($planPath)
    } else { $requestJson = $PlanJson }
    $catalogPath = Join-Path (Join-Path $PSScriptRoot '..') '.ae-codex/functions/catalog.json'
    $requestJson = ConvertTo-AeFunctionRequest -Json $requestJson -CatalogPath $catalogPath
    if ($AsToolOutput) {
        & (Join-Path $PSScriptRoot 'Submit-AeJsx.ps1') -FunctionRequestJson $requestJson -TimeoutSeconds $TimeoutSeconds 3>$null 4>$null 5>$null 6>$null
    } else {
        & (Join-Path $PSScriptRoot 'Submit-AeJsx.ps1') -FunctionRequestJson $requestJson -TimeoutSeconds $TimeoutSeconds
    }
} catch {
    if ($AsToolOutput) {
        [ordered]@{ schema = 'aect-tool-error/v1'; state = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Depth 8 -Compress
        exit 1
    }
    throw
}
