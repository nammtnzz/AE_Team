#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '..'),
    [switch]$Force
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
$bundlePath = Join-Path $WorkspaceRoot 'jsx/AECT Engine.jsx'
$verifierPath = Join-Path $WorkspaceRoot 'tools/Build-AeScriptBundle.js'
$certificateRoot = Join-Path $WorkspaceRoot '.ae-codex/bundle'
$jsonPath = Join-Path $certificateRoot 'installed-validation.json'
$tsvPath = Join-Path $certificateRoot 'installed-validation.tsv'
$utf8 = [Text.UTF8Encoding]::new($false, $true)

function Read-BundleIdentity {
    $bytes = [IO.File]::ReadAllBytes($bundlePath)
    # Decode only complete header lines; a fixed-size UTF-8 slice could split
    # a valid non-ASCII character in the runtime that follows the header.
    $headerEnd = -1
    $lineCount = 0
    for ($position = 0; $position -lt [Math]::Min($bytes.Length, 1024); $position++) {
        if ($bytes[$position] -eq 10) {
            $lineCount++
            if ($lineCount -eq 3) { $headerEnd = $position + 1; break }
        }
    }
    if ($headerEnd -lt 0) { throw 'Bundle header is missing.' }
    $prefix = $utf8.GetString($bytes, 0, $headerEnd)
    $lines = $prefix.Split("`n")
    if ($lines.Length -lt 4) { throw 'Bundle header is missing.' }
    $fields = $lines[2].TrimEnd("`r").Split("`t")
    if ($fields.Length -ne 7 -or $fields[0] -cne '// AECT_BUNDLE_V2' -or
        $fields[1] -cnotmatch '^[0-9a-f]{64}$' -or $fields[2] -notmatch '^\d+$' -or
        $fields[3] -notmatch '^\d+$' -or $fields[4] -notmatch '^\d+$' -or $fields[6] -notmatch '^[1-9]\d*$') {
        throw 'Bundle header is invalid.'
    }
    $offset = [long]$fields[3]
    $length = [long]$fields[4]
    if ([long]$fields[2] -ne $bytes.LongLength -or $offset -lt 0 -or $length -le 0 -or
        $offset -gt $bytes.LongLength -or $length -gt $bytes.LongLength - $offset) {
        throw 'Bundle byte size or index bounds are invalid.'
    }
    $index = $utf8.GetString($bytes, [int]$offset, [int]$length)
    $branchCount = 0
    $moduleCount = 0
    foreach ($line in $index.Split("`n")) {
        if ($line.StartsWith("B`t")) { $branchCount++ }
        elseif ($line.StartsWith("M`t")) { $moduleCount++ }
        elseif ($line.Length -ne 0) { throw 'Bundle index contains an unknown record.' }
    }
    if ($branchCount -ne [int]$fields[6] -or $moduleCount -lt 1) { throw 'Bundle record counts do not match its header.' }
    [pscustomobject]@{
        revision = $fields[1]
        fileBytes = $bytes.LongLength
        branches = $branchCount
        modules = $moduleCount
        sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    }
}

function Write-AtomicUtf8 {
    param([string]$Path, [string]$Text)
    $temporaryPath = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText($temporaryPath, $Text, $utf8)
        [IO.File]::Move($temporaryPath, $Path, $true)
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
    }
}

if (-not (Test-Path -LiteralPath $verifierPath -PathType Leaf)) { throw "Bundle verifier not found: $verifierPath" }
$identity = Read-BundleIdentity
$expectedTsv = "aect-install/v1`t$($identity.revision)`t$($identity.fileBytes)`t$($identity.branches)`t$($identity.modules)`t$($identity.sha256)`n"
$certificate = $null
$cached = $false
if (-not $Force -and (Test-Path -LiteralPath $jsonPath -PathType Leaf) -and (Test-Path -LiteralPath $tsvPath -PathType Leaf)) {
    try {
        $candidate = [IO.File]::ReadAllText($jsonPath, $utf8) | ConvertFrom-Json
        $cached = $candidate.schema -ceq 'aect-installed-validation/v1' -and $candidate.state -ceq 'success' -and
            $candidate.revision -ceq $identity.revision -and $candidate.fileBytes -eq $identity.fileBytes -and
            $candidate.branches -eq $identity.branches -and $candidate.modules -eq $identity.modules -and
            $candidate.sha256 -ceq $identity.sha256 -and [IO.File]::ReadAllText($tsvPath, $utf8) -ceq $expectedTsv
        if ($cached) { $certificate = $candidate }
    } catch { $cached = $false }
}
if (-not $cached) {
    New-Item -ItemType Directory -Force -Path $certificateRoot | Out-Null
    $logPath = Join-Path $certificateRoot ("installation-validation-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))-$([guid]::NewGuid().ToString('N').Substring(0,8)).log")
    $nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $verificationOutput = @(& $nodePath $verifierPath --verify 2>&1)
    $verificationExitCode = $LASTEXITCODE
    $verificationText = ($verificationOutput | ForEach-Object { [string]$_ }) -join "`n"
    Write-AtomicUtf8 -Path $logPath -Text ($verificationText + "`n")
    if ($verificationExitCode -ne 0) { throw "Bundle installation validation failed (exit $verificationExitCode). See $logPath" }
    try { $verified = $verificationText | ConvertFrom-Json } catch { throw "Bundle verifier returned invalid JSON. See $logPath" }
    if ($verified.revision -cne $identity.revision -or $verified.bytes -ne $identity.fileBytes -or
        $verified.branches -ne $identity.branches -or $verified.modules -ne $identity.modules) {
        throw "Bundle verification metadata changed during validation. See $logPath"
    }
    $currentIdentity = Read-BundleIdentity
    if ($currentIdentity.sha256 -cne $identity.sha256) { throw 'Bundle changed during installation validation. Rebuild and install again.' }
    $certificate = [ordered]@{
        schema = 'aect-installed-validation/v1'
        state = 'success'
        revision = $identity.revision
        fileBytes = $identity.fileBytes
        branches = $identity.branches
        modules = $identity.modules
        sha256 = $identity.sha256
        verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
        bundlePath = $bundlePath
        verificationLogPath = $logPath
    }
    # Each reader gets a complete file. A mismatched pair is treated as a cache miss.
    Write-AtomicUtf8 -Path $jsonPath -Text (($certificate | ConvertTo-Json) + "`n")
    Write-AtomicUtf8 -Path $tsvPath -Text $expectedTsv
}
[ordered]@{
    state = 'success'
    cached = [bool]$cached
    revision = $identity.revision
    fileBytes = $identity.fileBytes
    branches = $identity.branches
    modules = $identity.modules
    sha256 = $identity.sha256
    verifiedAtUtc = $certificate.verifiedAtUtc
    certificatePath = $jsonPath
    runtimeCertificatePath = $tsvPath
} | ConvertTo-Json
