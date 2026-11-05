#Requires -Version 7.0
param([Parameter(Mandatory)][string]$PayloadRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'TeamMaintenance.ps1')
$sandbox=Join-Path ([IO.Path]::GetTempPath()) ('ae-codexteam-test-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw "FAILED: $Message"};$script:checks++}
$pwsh=(Get-Process -Id $PID).Path
function Install-Fixture([string]$Package) {
    $text=& $pwsh -NoProfile -File (Join-Path $Package 'tools/Install-AeCodexTeam.ps1') -InstallRoot $install -AppDataRoot $appData -VersionFolder '26.5' -Fixture -LegacySearchRoot (Join-Path $sandbox 'no-legacy')
    return ($text -join "`n") | ConvertFrom-Json
}
function Old-Version([string]$Id,[switch]$Modified) {
    $dir=Join-Path $install ('versions/'+$Id);[IO.Directory]::CreateDirectory((Join-Path $dir 'tools')) | Out-Null
    $file=Join-Path $dir 'tools/program.txt';[IO.File]::WriteAllText($file,'owned program')
    $digest=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest=@{schema='aect-distribution/v1';packageId=$Id;files=@(@{path='tools/program.txt';sha256=$digest;bytes=13})}
    [IO.File]::WriteAllText((Join-Path $dir 'distribution.json'),($manifest | ConvertTo-Json -Depth 5))
    [IO.Directory]::CreateDirectory((Join-Path $dir '.ae-codex/library')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $dir '.ae-codex/library/user-data.json'),'preserve me')
    if($Modified){[IO.File]::WriteAllText($file,'my modified program')}
    return $dir
}
try {
    [IO.Directory]::CreateDirectory($sandbox) | Out-Null
    $install=Join-Path $sandbox 'install';$appData=Join-Path $sandbox 'appData'
    $history=Join-Path $sandbox 'history';$inbox=Join-Path $history '.ae-codex/bridge/inbox';[IO.Directory]::CreateDirectory($inbox) | Out-Null
    [IO.File]::WriteAllText((Join-Path $inbox 'job-old.job.rejected-123'),'historical rejection')
    Assert-TeamIdle $history
    Check $true 'historical rejected files do not masquerade as pending work'
    [IO.File]::WriteAllText((Join-Path $inbox 'job-active.job'),'pending')
    $refused=$false;try{Assert-TeamIdle $history}catch{$refused=$true}
    Check $refused 'actual queued jobs block update'
    $first=Install-Fixture $PayloadRoot
    Check ($first.state -eq 'success') 'first install succeeds'
    Check (Test-Path -LiteralPath $first.runtimeRoot) 'versioned runtime exists'
    Check (Test-Path -LiteralPath (Join-Path $appData 'Adobe/After Effects/26.5/Scripts/ScriptUI Panels/AE_CodexTeam Bridge.jsx')) 'thin AE loader installed only in redirected profile'
    foreach ($relativeLoader in @('ScriptUI Panels/AE_CodexTeam Bridge.jsx','Startup/AE_CodexTeam Bridge Startup.jsx')) {
        $loaderText = [IO.File]::ReadAllText((Join-Path $appData ('Adobe/After Effects/26.5/Scripts/' + $relativeLoader)))
        $literal = [regex]::Match($loaderText, 'bundle = new File\(("(?:\\.|[^"\\])*")\);').Groups[1].Value
        $loaderTarget = $literal | ConvertFrom-Json
        Check ($loaderTarget -ceq (Join-Path $first.runtimeRoot 'jsx/AECT Engine.jsx').Replace('\','/') -and (Test-Path -LiteralPath $loaderTarget)) 'AE loader resolves the installed bundle without native backslash escapes'
    }
    # Default image skill: installed into a sandboxed Claude skills folder in fixture mode, never with keys.
    $skillDir = Join-Path $install 'fixture-claude-skills/iw-imagegen'
    Check ($first.imageSkill.state -eq 'installed' -and $first.imageSkill.needsKey -and (Test-Path -LiteralPath (Join-Path $skillDir 'scripts/image_gen.py'))) 'iw-imagegen skill installs with the package'
    Check (-not (Select-String -LiteralPath (Join-Path $skillDir '.env') -Pattern '^OPENAI_API_KEY=.+' -Quiet)) 'a new .env starts empty from .env.example; no key ships'
    Check (-not (Select-String -LiteralPath (Join-Path $skillDir 'SKILL.md') -Pattern 'QuanNH|nguye' -Quiet)) 'skill paths are per-user, not tied to one machine'
    [IO.File]::WriteAllText((Join-Path $skillDir '.env'), "OPENAI_API_KEY=user-fixture-key`n")
    [IO.File]::WriteAllText((Join-Path $skillDir 'SKILL.md'), 'user edit')
    $again=Install-Fixture $PayloadRoot
    Check ($again.state -eq 'success' -and $again.runtimeRoot -eq $first.runtimeRoot) 'repair is idempotent'
    if (Test-Path -LiteralPath (Join-Path $PayloadRoot 'knowledge/shared-lessons.json')) {
        Check ($first.knowledge.state -eq 'merged' -and $first.knowledge.added -ge 1 -and (Test-Path -LiteralPath (Join-Path $install 'knowledge/lessons.json'))) 'shared lessons merge into the installation knowledge store'
        Check ($again.knowledge.state -eq 'merged' -and $again.knowledge.added -eq 0) 'reinstalling the same release adds no duplicate lessons'
    }
    Check ([IO.File]::ReadAllText((Join-Path $skillDir '.env')) -match 'user-fixture-key') 'reinstall never replaces the user''s .env'
    Check ($again.imageSkill.backedUp -eq 1 -and @(Get-ChildItem -LiteralPath $skillDir -Directory -Filter '.ae-team-backup-*').Count -eq 1) 'a locally changed skill file is backed up before refresh'
    $skipText=& $pwsh -NoProfile -File (Join-Path $PayloadRoot 'tools/Install-AeCodexTeam.ps1') -InstallRoot $install -AppDataRoot $appData -VersionFolder '26.5' -Fixture -SkipTeam
    $skip=($skipText -join "`n") | ConvertFrom-Json
    $skipMeta=Read-TeamJson (Join-Path $install 'installation.json')
    Check ($skip.state -eq 'success' -and $skipMeta.teamVersion -eq $again.version) 'engine-only repair preserves the existing extension version record'
    $old=Old-Version '0.1.0-111111111111'
    $edited=Old-Version '0.1.0-222222222222' -Modified
    $busy=Old-Version '0.1.0-333333333333'
    [IO.Directory]::CreateDirectory((Join-Path $busy '.ae-codex/bridge')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $busy '.ae-codex/bridge/submit.lock'),'busy')
    $connected=Old-Version '0.1.0-444444444444'
    [IO.Directory]::CreateDirectory((Join-Path $connected '.ae-codex/bridge')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $connected '.ae-codex/bridge/heartbeat.json'),(@{state='running';timestampEpochMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json))
    $cleanup=Remove-TeamOldVersions $install -Fixture
    Check ($cleanup.removed.Count -eq 2 -and $cleanup.deferred.Count -eq 2) 'only verified inactive versions are retired'
    Check (-not (Test-Path -LiteralPath $old) -and (Test-Path -LiteralPath $first.runtimeRoot)) 'active version preserved'
    $preserved=Join-Path $install 'retired-data/0.1.0-111111111111'
    Check ([IO.File]::ReadAllText((Join-Path $preserved '.ae-codex/library/user-data.json')) -eq 'preserve me') 'user data retained'
    Check (-not (Test-Path -LiteralPath (Join-Path $preserved 'tools/program.txt'))) 'unmodified superseded code deleted'
    Check ([IO.File]::ReadAllText((Join-Path $install 'retired-data/0.1.0-222222222222/tools/program.txt')) -eq 'my modified program') 'modified code preserved'
    Check ((Test-Path -LiteralPath $busy) -and (Test-Path -LiteralPath $connected)) 'busy and connected runtimes untouched'
    $before=[IO.File]::ReadAllText((Join-Path $install 'installation.json'))
    $guard=Join-Path $appData 'Code/User/globalStorage/inwave-local.p0-team/update-guards';[IO.Directory]::CreateDirectory($guard) | Out-Null
    [IO.File]::WriteAllText((Join-Path $guard 'fixture.json'),(@{schema='ae-codexteam-update-guard/v1';active=$false;inFlight=$false;hold=$true;pendingApproval=$false} | ConvertTo-Json))
    $blocked=Install-Fixture $PayloadRoot
    Check ($blocked.state -eq 'error' -and -not $blocked.engineInstalled) 'uncertain team result blocks update before installation'
    [IO.File]::Delete((Join-Path $guard 'fixture.json'))
    $damaged=Join-Path $sandbox 'damaged';Copy-Item -LiteralPath $PayloadRoot -Destination $damaged -Recurse
    [IO.File]::AppendAllText((Join-Path $damaged 'engine/tools/AeLibrarySearch.js'),'tampered')
    $bad=Install-Fixture $damaged
    Check ($bad.state -eq 'error' -and -not $bad.engineInstalled) 'tampered package rejected'
    Check ([IO.File]::ReadAllText((Join-Path $install 'installation.json')) -eq $before) 'failed preflight leaves active pointer intact'
    $statusText=& node (Join-Path $PayloadRoot 'tools/TeamStatus.cjs') $install
    $status=($statusText -join "`n") | ConvertFrom-Json
    Check ($status.state -eq 'disconnected') 'installed without fresh AE heartbeat never reports connected'
    $heldLock=[IO.File]::Open((Join-Path $install '.ae-codex/setup/team-install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $lockedText=& $pwsh -NoProfile -File (Join-Path $PayloadRoot 'tools/Cleanup-AeCodexTeam.ps1') -InstallRoot $install
        $locked=($lockedText -join "`n") | ConvertFrom-Json
        Check ($locked.state -eq 'deferred' -and $locked.reason -match 'team-install.lock') 'launch cleanup defers while installer holds its lock'
        Check ([IO.File]::ReadAllText((Join-Path $install 'installation.json')) -eq $before) 'concurrent cleanup leaves installation pointer unchanged'
    } finally { $heldLock.Dispose() }
    $result=[ordered]@{state='success';checks=$checks;fixtureOnly=$true}
    $result | ConvertTo-Json
} finally {
    $absolute=[IO.Path]::GetFullPath($sandbox)
    if ((Test-TeamChild $absolute ([IO.Path]::GetTempPath())) -and [IO.Path]::GetFileName($absolute).StartsWith('ae-codexteam-test-')) {
        Assert-TeamPlainPath $absolute
        if(Test-Path -LiteralPath $absolute){Remove-Item -LiteralPath $absolute -Recurse -Force}
    }
}
