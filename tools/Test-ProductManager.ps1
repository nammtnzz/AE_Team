#Requires -Version 7.0
[CmdletBinding()]
param([string]$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw 'Framework64 csc.exe is required for the Product Manager fixture.' }
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('ae-product-manager-layout-' + [guid]::NewGuid().ToString('N'))
try {
    [IO.Directory]::CreateDirectory($sandbox) | Out-Null
    $exe = Join-Path $sandbox 'ProductManagerLayout.exe'
    $source = Join-Path $Root 'tools/ProductManager.cs'
    $fixture = Join-Path $Root 'test/ProductManagerLayout.cs'
    foreach ($file in @($source, $fixture)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing fixture source: $file" }
    }
    & $csc /nologo /target:exe /optimize+ /utf8output `
        /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll `
        "/out:$exe" $source $fixture
    if ($LASTEXITCODE -ne 0) { throw 'Product Manager fixture compilation failed.' }
    $result = & $exe
    if ($LASTEXITCODE -ne 0) { throw (($result -join "`n")) }
    ($result -join "`n")
} finally {
    $fixtureTarget = [IO.Path]::GetFullPath($sandbox)
    $fixtureTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + [IO.Path]::DirectorySeparatorChar
    if (-not $fixtureTarget.StartsWith($fixtureTempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($fixtureTarget) -notmatch '^ae-product-manager-layout-[a-f0-9]{32}$') { throw 'Fixture cleanup escaped its temporary directory.' }
    if (Test-Path -LiteralPath $fixtureTarget) { Remove-Item -LiteralPath $fixtureTarget -Recurse -Force -ErrorAction SilentlyContinue }
}
