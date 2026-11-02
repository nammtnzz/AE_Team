#Requires -Version 7.0
param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$build=& node (Join-Path $PSScriptRoot 'build-release.cjs') | ConvertFrom-Json
if($LASTEXITCODE -ne 0){throw 'Payload build failed'}
$privacy=& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Verify-ReleasePrivacy.ps1') -PayloadRoot $build.payload | ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or $privacy.state -cne 'success'){throw 'Release privacy validation failed; installer was not built'}
$zip=Join-Path $build.stage 'payload.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($build.payload,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$target=Join-Path $OutputDirectory ('AE_CodexTeam-Setup-'+$build.version+'.exe')
& $csc /nologo /target:winexe /optimize+ /utf8output /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$zip,TeamPayload" "/out:$target" (Join-Path $PSScriptRoot 'TeamSetup.cs') (Join-Path $PSScriptRoot 'ProductManager.cs')
if($LASTEXITCODE -ne 0){throw 'Single-file installer compilation failed'}
$check=Start-Process -FilePath $target -ArgumentList '--check' -WindowStyle Hidden -Wait -PassThru
if($check.ExitCode -ne 0){throw 'Installer self-check failed'}
$result=[ordered]@{state='success';installer=$target;payload=$build.payload;version=$build.version;bytes=(Get-Item -LiteralPath $target).Length;sha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant();signed=$false}
$result | ConvertTo-Json
