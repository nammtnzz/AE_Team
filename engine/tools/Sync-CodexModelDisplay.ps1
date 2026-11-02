[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configRoot = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
} else { $env:CODEX_HOME }
$config = [IO.File]::ReadAllText((Join-Path $configRoot 'config.toml'))
$section = [regex]::Match($config, '(?m)^\s*\[')
$root = if ($section.Success) { $config.Substring(0, $section.Index) } else { $config }
$modelMatch = [regex]::Match($root, '(?m)^model\s*=\s*"([A-Za-z0-9._-]{1,100})"')
$model = if ($modelMatch.Success) { $modelMatch.Groups[1].Value } else { 'unknown' }
$stateRoot = Join-Path $workspaceRoot '.ae-codex'
[void][IO.Directory]::CreateDirectory($stateRoot)
$path = Join-Path $stateRoot 'model-display.txt'
$temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
$payload = "schema=codex-model-display/v1`nmodel=$model`nsource=config-default`nupdatedUtc=$([DateTime]::UtcNow.ToString('o'))`n"
try {
    [IO.File]::WriteAllText($temporary, $payload, [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($path)) {
        [IO.File]::Move($temporary, $path, $true)
    } else {
        [IO.File]::Move($temporary, $path)
    }
} finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
Write-Output "AE model display synced: $model (config default)"
