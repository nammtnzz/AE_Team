#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PayloadRoot,
    [string]$ReportPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PayloadRoot).TrimEnd([char[]]'\/')
$issues = [Collections.Generic.List[object]]::new()
$issueCount = 0
$scannedFiles = 0
$nestedEntries = 0
$maxFileBytes = 33554432
$maxTotalBytes = 134217728
$totalScannedBytes = 0L
$utf8 = [Text.UTF8Encoding]::new($false)
function Add-PrivacyIssue([string]$File,[string]$Kind) {
    $script:issueCount++
    if ($script:issues.Count -lt 200) { $script:issues.Add([pscustomobject]@{file=$File;kind=$Kind}) }
}
function Test-RelativePath([string]$Relative) {
    return ($Relative -and -not $Relative.Contains('\') -and -not [IO.Path]::IsPathRooted($Relative) -and
        $Relative -notmatch '[:\x00-\x1f]' -and $Relative -notmatch '(^|/)\.{1,2}(/|$)' -and
        $Relative -notmatch '//|/$')
}
function Get-PlainFile([string]$Relative) {
    if (-not (Test-RelativePath $Relative)) { throw 'Unsafe manifest path.' }
    $full = [IO.Path]::GetFullPath((Join-Path $root $Relative))
    if (-not $full.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest escaped payload.' }
    $cursor = $full
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked payload path.' }
        if ($cursor -ieq $root) { break }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    return $full
}
function Read-ReleaseJson([string]$Relative) {
    $full=Get-PlainFile $Relative
    if (-not [IO.File]::Exists($full) -or (Get-Item -LiteralPath $full).Length -gt $maxFileBytes) { throw 'Missing or oversized manifest.' }
    return [IO.File]::ReadAllText($full) | ConvertFrom-Json
}
function Test-Placeholder([string]$Value) {
    return ($Value -match '(?i)(example|placeholder|fixture|redacted|dummy|replace[-_]?me|your[-_])' -or
        $Value -match '^(?:sk-|gh[pousr]_|github_pat_)?([xX0])\1{19,}$')
}
$privatePatterns = [ordered]@{
    'personal-profile-path' = '(?i)[A-Z]:(?:\\{1,2}|/)Users(?:\\{1,2}|/)[^\\/\s"''<>]+'
    'private-key' = '-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----'
    'provider-token' = '(?<![A-Za-z0-9_-])(?:sk-(?:proj-|svcacct-|ant-api\d+-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9_]{32,}|github_pat_[A-Za-z0-9_]{40,})(?![A-Za-z0-9_-])'
    'aws-access-key' = '(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])'
    'literal-jwt-bearer' = '(?i)Bearer\s+eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'
}
function Test-PrivacyText([string]$Label,[string]$Text) {
    foreach ($pattern in $privatePatterns.GetEnumerator()) {
        foreach ($match in [regex]::Matches($Text,$pattern.Value)) {
            if ($pattern.Key -eq 'personal-profile-path' -or $pattern.Key -eq 'private-key' -or -not (Test-Placeholder $match.Value)) {
                Add-PrivacyIssue $Label $pattern.Key
                break
            }
        }
    }
}
function Test-PrivacyBytes([string]$Label,[byte[]]$Bytes,[switch]$Binary) {
    $script:totalScannedBytes += $Bytes.Length
    if ($Bytes.Length -gt $maxFileBytes -or $script:totalScannedBytes -gt $maxTotalBytes) { throw 'Privacy scan size limit exceeded.' }
    $script:scannedFiles++
    Test-PrivacyText $Label ([Text.Encoding]::UTF8.GetString($Bytes))
    if ($Binary) {
        # Native strings can be narrow or UTF-16. Decode only during this build check.
        Test-PrivacyText $Label ([Text.Encoding]::ASCII.GetString($Bytes))
        Test-PrivacyText $Label ([Text.Encoding]::Unicode.GetString($Bytes))
        if ($Bytes.Length -gt 1) { Test-PrivacyText $Label ([Text.Encoding]::Unicode.GetString($Bytes,1,$Bytes.Length-1)) }
    }
}
function Test-ManifestFiles($Manifest,[string]$Prefix) {
    $result = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $Manifest.files) {
        $relative=[string]$file.path
        if (-not (Test-RelativePath $relative) -or $result.ContainsKey($relative)) { throw 'Unsafe or duplicate manifest path.' }
        $label=$Prefix+$relative
        $full=Get-PlainFile $label
        if ([string]$file.sha256 -cnotmatch '^[0-9a-f]{64}$' -or [long]$file.bytes -lt 0 -or [long]$file.bytes -gt $maxFileBytes) { throw 'Invalid manifest hash or size.' }
        if (-not [IO.File]::Exists($full)) { Add-PrivacyIssue $label 'missing-manifest-file' }
        elseif ((Get-Item -LiteralPath $full).Length -ne [long]$file.bytes -or (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ine [string]$file.sha256) { Add-PrivacyIssue $label 'manifest-checksum-mismatch' }
        $result.Add($relative,$file)
    }
    return ,$result
}
try {
    if (-not [IO.Directory]::Exists($root)) { throw 'Payload root is missing.' }
    $null=Get-PlainFile 'product.json'
    $product=Read-ReleaseJson 'product.json'
    if ($product.schema -cne 'ae-codexteam-package/v1' -or $product.product -cne 'AE_CodexTeam' -or
        [string]$product.version -cnotmatch '^\d+\.\d+\.\d+$' -or $product.vsix -cne ('team/ae-codexteam-'+$product.version+'.vsix')) { throw 'Invalid product identity.' }
    $productFiles=Test-ManifestFiles $product ''
    $engine=Read-ReleaseJson 'engine/distribution.json'
    if ($engine.schema -cne 'aect-distribution/v1') { throw 'Invalid engine manifest.' }
    $engineFiles=Test-ManifestFiles $engine 'engine/'
    $allowedTools=@('TeamMaintenance.ps1','Install-AeCodexTeam.ps1','Manage-AeCodexTeam.ps1','Cleanup-AeCodexTeam.ps1','TeamStatus.cjs','TeamKnowledge.cjs')
    $allowedNative=@('AE_CodexTeam_Native.aex','Install-NativePlugin.ps1')
    $allowedState=@('.ae-codex/functions/catalog.json','.ae-codex/functions/capabilities.json','.ae-codex/library/USAGE.md','.ae-codex/plugins/USAGE.md')
    $expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $null=$expected.Add('product.json')
    # Sanitized shared lessons (optional); the content scan below still rejects personal paths and secrets.
    $null=$expected.Add('knowledge/shared-lessons.json')
    $null=$expected.Add('engine/distribution.json')
    $null=$expected.Add([string]$product.vsix)
    foreach($name in $allowedTools){$null=$expected.Add('tools/'+$name)}
    foreach($name in $allowedNative){$null=$expected.Add('native/'+$name)}
    # Bundled default image skill: program files only. Gateway keys live in the user's own .env, which never ships.
    foreach($name in @('SKILL.md','.env.example','agents/openai.yaml','references/prompting.md','references/sample-prompts.md','scripts/image_gen.py')){$null=$expected.Add('skills/iw-imagegen/'+$name)}
    foreach($relative in $productFiles.Keys){if($relative -match '(^|/).env$'){Add-PrivacyIssue $relative 'credential-file'}}
    foreach($relative in $engineFiles.Keys){
        if ($relative -match '^\.ae-codex/' -and $relative -cnotin $allowedState) { Add-PrivacyIssue ('engine/'+$relative) 'engine-local-state' }
        elseif ($relative -notmatch '^(?:source/[^/]+\.(?:js|json)|tools/[^/]+\.(?:js|ps1|cs)|jsx/AECT Engine\.jsx|AGENTS\.md|\.ae-codex/(?:functions/(?:catalog|capabilities)\.json|(?:library|plugins)/USAGE\.md))$') { Add-PrivacyIssue ('engine/'+$relative) 'unexpected-engine-path' }
        $null=$expected.Add('engine/'+$relative)
    }
    foreach($relative in $productFiles.Keys){if(-not $expected.Contains($relative)){Add-PrivacyIssue $relative 'unexpected-product-manifest-path'}}
    foreach($relative in $expected){if($relative-cne 'product.json'-and -not $productFiles.ContainsKey($relative)){Add-PrivacyIssue $relative 'missing-product-manifest-entry'}}
    $expectedDirs=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($relative in $expected){$parts=$relative.Split('/');for($i=1;$i-lt $parts.Length;$i++){$null=$expectedDirs.Add(($parts[0..($i-1)]-join '/'))}}
    $actual=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($root)
    while($queue.Count){
        $directory=$queue.Dequeue()
        foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)){
            $relative=$entry.Substring($root.Length+1).Replace('\','/')
            $attributes=[IO.File]::GetAttributes($entry)
            if($attributes-band [IO.FileAttributes]::ReparsePoint){Add-PrivacyIssue $relative 'linked-payload-entry';continue}
            if($attributes-band [IO.FileAttributes]::Directory){if(-not $expectedDirs.Contains($relative)){Add-PrivacyIssue $relative 'unexpected-payload-directory'};$queue.Enqueue($entry);continue}
            if(-not $actual.Add($relative)){Add-PrivacyIssue $relative 'case-colliding-payload-path'}
            if(-not $expected.Contains($relative)){Add-PrivacyIssue $relative 'unexpected-payload-file'}
            if((Get-Item -LiteralPath $entry).Length-gt $maxFileBytes){Add-PrivacyIssue $relative 'oversized-payload-file';continue}
            if($relative-cne $product.vsix){Test-PrivacyBytes $relative ([IO.File]::ReadAllBytes($entry)) -Binary:($relative.EndsWith('.aex',[StringComparison]::OrdinalIgnoreCase))}
            if($actual.Count-gt 10000){throw 'Payload entry limit exceeded.'}
        }
    }
    foreach($relative in $expected){if(-not $actual.Contains($relative)){Add-PrivacyIssue $relative 'missing-payload-file'}}
    $vsixPath=Get-PlainFile ([string]$product.vsix)
    Add-Type -AssemblyName System.IO.Compression
    $stream=[IO.File]::OpenRead($vsixPath)
    $archive=$null
    try{
        $archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read,$false)
        $allowedVsix=@('extension.vsixmanifest','[Content_Types].xml','extension/package.json','extension/readme.md','extension/changelog.md','extension/LICENSE.txt','extension/THIRD-PARTY-NOTICES.md','extension/dist/extension.bundle.js',
            'extension/media/work-status.js','extension/media/views.js','extension/media/views.css','extension/media/team.svg','extension/media/office.js','extension/media/index.html','extension/media/board.js','extension/media/board.css')
        $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach($entry in $archive.Entries){
            $script:nestedEntries++
            $label=[string]$product.vsix+'!/'+$entry.FullName
            if(-not (Test-RelativePath $entry.FullName)-or -not $seen.Add($entry.FullName)){Add-PrivacyIssue $label 'unsafe-or-duplicate-vsix-path';continue}
            if($entry.FullName-cnotin $allowedVsix){Add-PrivacyIssue $label 'unexpected-vsix-entry'}
            if($entry.Length-gt $maxFileBytes -or $script:nestedEntries-gt 1000){throw 'VSIX entry limit exceeded.'}
            $entryStream=$entry.Open();$buffer=[IO.MemoryStream]::new()
            try{$entryStream.CopyTo($buffer);Test-PrivacyBytes $label $buffer.ToArray()}finally{$entryStream.Dispose();$buffer.Dispose()}
        }
        foreach($required in $allowedVsix){if(-not $seen.Contains($required)){Add-PrivacyIssue ([string]$product.vsix+'!/'+$required) 'missing-vsix-entry'}}
    }finally{if($archive){$archive.Dispose()}else{$stream.Dispose()}}
}catch{
    # Exceptions may include scanned values or local paths; never echo their text.
    Add-PrivacyIssue '(payload)' 'validation-error'
}
$report=[ordered]@{schema='ae-codexteam-release-privacy/v1';state=$(if($issueCount){'error'}else{'success'});scannedFiles=$scannedFiles;nestedVsixEntries=$nestedEntries;scannedBytes=$totalScannedBytes;issueCount=$issueCount;issues=$issues.ToArray();issuesTruncated=($issueCount-gt $issues.Count);buildTimeOnly=$true}
$json=$report|ConvertTo-Json -Depth 6
if($ReportPath){$reportFull=[IO.Path]::GetFullPath($ReportPath);[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($reportFull))|Out-Null;[IO.File]::WriteAllText($reportFull,$json,$utf8)}
$json
if($issueCount){exit 1}
