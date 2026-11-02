[CmdletBinding()]
param(
    [string]$Search,
    [switch]$IncludeLegacy,
    [switch]$LegacyOnly,
    [ValidateSet('All', 'ReadOnly', 'Mutating')][string]$Type = 'All',
    [string]$CatalogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $CatalogPath) { $CatalogPath = Join-Path (Join-Path $PSScriptRoot '..') '.ae-codex/functions/catalog.json' }
if (-not (Test-Path -LiteralPath $CatalogPath -PathType Leaf)) {
    throw 'The AE function catalog is missing. Run node tools/Build-AeScriptBundle.js to generate it.'
}
$catalog = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($CatalogPath)) -AsHashtable -Depth 64
if ($catalog.schema -ne 'aect-functions-catalog/v1') { throw "Unsupported function catalog: $CatalogPath" }
$entries = @()
if (-not $LegacyOnly) {
    foreach ($item in $catalog.functions) { $entries += $item }
}
if ($IncludeLegacy -or $LegacyOnly) {
    foreach ($item in $catalog.legacyBranches) {
        $entry = [ordered]@{ name = $item.name; function = $item.function; args = $item.args; legacy = $true; mutates = $true }
        if ($item.Contains('description')) { $entry['description'] = $item.description }
        $entries += $entry
    }
}
if ($Search) {
    $entries = @($entries | Where-Object { ($_ | ConvertTo-Json -Depth 32 -Compress).IndexOf($Search, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
}
if ($Type -ne 'All') {
    $mutating = $Type -eq 'Mutating'
    $entries = @($entries | Where-Object { [bool]$_.mutates -eq $mutating })
}
[ordered]@{
    schema = 'aect-functions-list/v1'
    bridgeVersion = $catalog.bridgeVersion
    count = $entries.Count
    functions = @($entries)
} | ConvertTo-Json -Depth 64
