# Shared resolver for physical JSX scripts and virtual bundle branches.
function Resolve-AeScriptTarget {
    param([string]$WorkspaceRoot, [string]$Script, [string]$Branch)
    $jsxRoot = [IO.Path]::GetFullPath((Join-Path $WorkspaceRoot 'jsx'))
    if ($Branch) {
        if ($Branch -notmatch '^[A-Za-z0-9 _.-]+(?:\.jsx)?$' -or $Branch.Contains('..')) { throw 'Invalid branch name.' }
        if (-not $Branch.EndsWith('.jsx', [StringComparison]::OrdinalIgnoreCase)) { $Branch += '.jsx' }
        $scriptPath = [IO.Path]::GetFullPath((Join-Path $jsxRoot $Branch))
    } else {
        $scriptPath = [IO.Path]::GetFullPath($Script)
    }
    if ([IO.Path]::GetExtension($scriptPath) -ine '.jsx' -or
        -not ([IO.Path]::GetDirectoryName($scriptPath)).Equals($jsxRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Only direct .jsx scripts or branches inside $jsxRoot are allowed."
    }
    $name = [IO.Path]::GetFileName($scriptPath)
    $bundlePath = Join-Path $jsxRoot 'AECT Engine.jsx'
    $bundled = $false
    if (Test-Path -LiteralPath $bundlePath -PathType Leaf) {
        $bundleFile = [IO.File]::OpenRead($bundlePath)
        try {
            $reader = [IO.StreamReader]::new($bundleFile, [Text.Encoding]::UTF8, $true, 4096, $true)
            try { $null = $reader.ReadLine(); $null = $reader.ReadLine(); $header = $reader.ReadLine() }
            finally { $reader.Dispose() }
            if ($header -and ($header.StartsWith("// AECT_BUNDLE_V1`t") -or $header.StartsWith("// AECT_BUNDLE_V2`t"))) {
                $fields = $header.Split("`t")
                if ($fields.Count -ne 7 -or [long]$fields[2] -ne $bundleFile.Length -or [int]$fields[4] -gt 1048576) { throw 'Invalid bundle header/size.' }
                $null = $bundleFile.Seek([long]$fields[3], [IO.SeekOrigin]::Begin)
                $indexBytes = [byte[]]::new([int]$fields[4])
                $bundleFile.ReadExactly($indexBytes)
                $rows = [Text.Encoding]::ASCII.GetString($indexBytes).TrimEnd("`n").Split("`n")
                $branchRows = if ($fields[0] -eq '// AECT_BUNDLE_V2') { @($rows | Where-Object { $_.StartsWith("B`t") }) } else { $rows }
                if ($branchRows.Count -ne [int]$fields[6]) { throw 'Missing bundle branches.' }
                foreach ($row in $branchRows) {
                    $rowName = if ($fields[0] -eq '// AECT_BUNDLE_V2') { $row.Split("`t")[1] } else { $row.Split("`t")[0] }
                    if ($rowName.Equals($name, [StringComparison]::OrdinalIgnoreCase)) { $bundled = $true; $name = $rowName; break }
                }
            }
        } finally { $bundleFile.Dispose() }
    }
    if (-not $bundled -and ($Branch -or -not (Test-Path -LiteralPath $scriptPath -PathType Leaf))) {
        throw "JSX file or bundled branch not found: $name"
    }
    [pscustomobject]@{ Path = $scriptPath; Name = $name; Bundled = $bundled; RelativePath = "jsx/$name" }
}
