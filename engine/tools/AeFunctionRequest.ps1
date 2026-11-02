# Shared data-only request validation. Dot-source from CLI entry points.
function ConvertTo-AeFunctionRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [string]$CatalogPath
    )

    if ([System.Text.Encoding]::UTF8.GetByteCount($Json) -gt 131072) {
        throw 'Function request exceeds 128 KiB of UTF-8 JSON.'
    }
    try { $request = ConvertFrom-Json -InputObject $Json -AsHashtable -Depth 64 -ErrorAction Stop }
    catch { throw "Invalid function request JSON: $($_.Exception.Message)" }
    if ($request -isnot [System.Collections.IDictionary] -or $request.schema -ne 'aect-functions/v1') {
        throw 'Function request must be an object with schema aect-functions/v1.'
    }
    foreach ($key in $request.Keys) {
        if ($key -notin @('schema', 'steps')) { throw "Unsupported function request field: $key" }
    }
    if ($request.steps -isnot [System.Collections.IList] -or $request.steps.Count -lt 1 -or $request.steps.Count -gt 100) {
        throw 'Function request must contain between 1 and 100 steps.'
    }

    $catalog = $null
    if ($CatalogPath -and (Test-Path -LiteralPath $CatalogPath -PathType Leaf)) {
        $catalog = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($CatalogPath)) -AsHashtable -Depth 64
        if ($catalog.schema -ne 'aect-functions-catalog/v1') { throw "Unsupported function catalog: $CatalogPath" }
    }
    $aliases = @{}
    $normalized = @()
    foreach ($step in $request.steps) {
        if ($step -isnot [System.Collections.IDictionary]) { throw 'Each function step must be an object.' }
        foreach ($key in $step.Keys) {
            if ($key -notin @('function', 'args', 'as')) { throw "Unsupported function step field: $key" }
        }
        if ($step.function -isnot [string] -or $step.function -cnotmatch '^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$') {
            throw 'Each step requires a named function, for example project.inspect.'
        }
        $arguments = if ($step.Contains('args')) { $step.args } else { [ordered]@{} }
        if ($arguments -isnot [System.Collections.IDictionary]) { throw "Arguments for $($step.function) must be a JSON object." }
        $knownFunctions = if ($catalog) { @($catalog.functions) + $(if ($catalog.Contains('maintenanceFunctions')) { @($catalog.maintenanceFunctions) } else { @() }) } else { @() }
        if ($catalog -and @($knownFunctions | Where-Object { $_.name -ceq $step.function }).Count -ne 1) {
            throw "Unknown AE function '$($step.function)'. Run tools/Get-AeFunctions.ps1 to list installed functions."
        }
        if ($step.function -ceq 'team.script.run') {
            if ($arguments.branch -isnot [string] -or [string]::IsNullOrWhiteSpace($arguments.branch)) {
                throw 'script.run requires args.branch naming an installed branch.'
            }
            $branch = $arguments.branch
            if ($branch -notmatch '\.jsx$') { $branch += '.jsx' }
            if ($branch -match '[/\\]' -or $branch.Contains('..')) { throw 'script.run branch must be a branch name, without a path.' }
            if ($catalog) {
                $matches = @($catalog.legacyBranches | Where-Object { $_.name -ieq $branch })
                if ($matches.Count -ne 1) { throw "Unknown installed branch '$branch'. Run Get-AeFunctions.ps1 -IncludeLegacy -Search to find it." }
                $branch = [string]$matches[0].name
            }
            $arguments.branch = $branch
        }
        $entry = [ordered]@{ function = $step.function; args = $arguments }
        if ($step.Contains('as')) {
            if ($step.as -isnot [string] -or $step.as -cnotmatch '^[A-Za-z][A-Za-z0-9_]{0,63}$') {
                throw 'Step aliases must start with a letter and contain at most 64 letters, digits or underscores.'
            }
            if ($aliases.ContainsKey($step.as)) { throw "Duplicate step alias: $($step.as)" }
            $aliases[$step.as] = $true
            $entry['as'] = $step.as
        }
        $normalized += $entry
    }
    $compact = [ordered]@{ schema = 'aect-functions/v1'; steps = $normalized } | ConvertTo-Json -Depth 64 -Compress
    if ([System.Text.Encoding]::UTF8.GetByteCount($compact) -gt 131072) { throw 'Function request exceeds 128 KiB of normalized UTF-8 JSON.' }
    return $compact
}
