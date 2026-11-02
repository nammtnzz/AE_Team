[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9-]{8,80}$')]
    [string]$RunId,

    [ValidateSet('', 'VISUAL_REVIEW_UNAVAILABLE', 'MODERATION_SERVICE_ERROR', 'IMAGE_DECODER_ERROR')]
    [string]$VisualReviewErrorCode = '',

    [string]$VisualReviewErrorMessage = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-IsPathInside {
    param(
        [Parameter(Mandatory = $true)][string]$ParentPath,
        [Parameter(Mandatory = $true)][string]$ChildPath
    )

    $relative = [System.IO.Path]::GetRelativePath($ParentPath, $ChildPath)
    return -not (
        [System.IO.Path]::IsPathRooted($relative) -or
        $relative -eq '..' -or
        $relative.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::Ordinal)
    )
}

function Read-UInt32BigEndian {
    param(
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][int]$Offset
    )

    return [uint32](
        ([uint64]$Bytes[$Offset] * 16777216) +
        ([uint64]$Bytes[$Offset + 1] * 65536) +
        ([uint64]$Bytes[$Offset + 2] * 256) +
        [uint64]$Bytes[$Offset + 3]
    )
}

function Test-NoReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)

    $attributes = [System.IO.File]::GetAttributes($Path)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Inspection path must not be a symbolic link or junction: $Path"
    }
}

function Assert-NoReparsePointWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root)
    $current = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-IsPathInside -ParentPath $rootFull -ChildPath $current)) {
        throw "Inspection path is outside the workspace: $current"
    }

    while ($true) {
        if (Test-Path -LiteralPath $current) {
            Test-NoReparsePoint -Path $current
        }
        if ($current.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent -or -not (Test-IsPathInside -ParentPath $rootFull -ChildPath $parent.FullName)) {
            throw "Cannot validate inspection path ancestry: $Path"
        }
        $current = $parent.FullName
    }
}

$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$inspectionRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.ae-codex\inspection'))
if (-not (Test-Path -LiteralPath $inspectionRoot -PathType Container)) {
    throw "No inspection captures exist yet. Call the installed inspection.capture tool through Invoke-AeFunction.ps1 first."
}
Assert-NoReparsePointWithin -Root $workspaceRoot -Path $inspectionRoot

if ([string]::IsNullOrWhiteSpace($RunId)) {
    $latest = Get-ChildItem -LiteralPath $inspectionRoot -Directory |
        Where-Object { $_.Name -match '^[A-Za-z0-9-]{8,80}$' } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($null -eq $latest) {
        throw "No valid inspection run folder was found under: $inspectionRoot"
    }
    $RunId = $latest.Name
}

$runFolder = [System.IO.Path]::GetFullPath((Join-Path $inspectionRoot $RunId))
$framePath = [System.IO.Path]::GetFullPath((Join-Path $runFolder 'frame.png'))
if (-not (Test-IsPathInside -ParentPath $inspectionRoot -ChildPath $runFolder) -or
    -not (Test-IsPathInside -ParentPath $runFolder -ChildPath $framePath)) {
    throw 'Inspection path escaped the workspace inspection root.'
}
if (-not (Test-Path -LiteralPath $runFolder -PathType Container)) {
    throw "Inspection run was not found: $RunId"
}
if (-not (Test-Path -LiteralPath $framePath -PathType Leaf)) {
    throw "Inspection frame was not found: $framePath"
}
Assert-NoReparsePointWithin -Root $workspaceRoot -Path $runFolder
Assert-NoReparsePointWithin -Root $workspaceRoot -Path $framePath

$frameInfo = Get-Item -LiteralPath $framePath
if ($frameInfo.Length -lt 33) {
    throw 'Inspection frame is too short to be a valid PNG.'
}
if ($frameInfo.Length -gt 100MB) {
    throw "Inspection frame exceeds the 100 MiB safety limit: $($frameInfo.Length) bytes"
}

$header = [byte[]]::new(33)
$headerStream = [System.IO.File]::OpenRead($framePath)
try {
    $readCount = $headerStream.Read($header, 0, $header.Length)
} finally {
    $headerStream.Dispose()
}
if ($readCount -ne 33) {
    throw 'Could not read the complete PNG header.'
}
$expectedSignature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
for ($index = 0; $index -lt $expectedSignature.Length; $index += 1) {
    if ($header[$index] -ne $expectedSignature[$index]) {
        throw 'Inspection frame has an invalid PNG signature.'
    }
}
if ([System.Text.Encoding]::ASCII.GetString($header, 12, 4) -ne 'IHDR') {
    throw 'Inspection PNG does not begin with an IHDR chunk.'
}

$width = Read-UInt32BigEndian -Bytes $header -Offset 16
$height = Read-UInt32BigEndian -Bytes $header -Offset 20
$pixelCount = [uint64]$width * [uint64]$height
if ($width -eq 0 -or $height -eq 0 -or $width -gt 16384 -or $height -gt 16384 -or $pixelCount -gt 100000000) {
    throw "Inspection dimensions exceed safety limits: ${width}x${height} ($pixelCount pixels)"
}

Add-Type -AssemblyName PresentationCore
$imageStream = [System.IO.File]::OpenRead($framePath)
try {
    $decoder = [System.Windows.Media.Imaging.PngBitmapDecoder]::new(
        $imageStream,
        [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
        [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    )
    $source = $decoder.Frames[0]
} finally {
    $imageStream.Dispose()
}
if ($source.PixelWidth -ne $width -or $source.PixelHeight -ne $height) {
    throw 'PNG decoder dimensions do not match the verified IHDR dimensions.'
}

$scale = [Math]::Min(1.0, 64.0 / [Math]::Max([double]$width, [double]$height))
if ($scale -lt 1.0) {
    $sample = [System.Windows.Media.Imaging.TransformedBitmap]::new(
        $source,
        [System.Windows.Media.ScaleTransform]::new($scale, $scale)
    )
} else {
    $sample = $source
}
$bgra = [System.Windows.Media.Imaging.FormatConvertedBitmap]::new(
    $sample,
    [System.Windows.Media.PixelFormats]::Bgra32,
    $null,
    0
)
$stride = $bgra.PixelWidth * 4
$pixels = [byte[]]::new($stride * $bgra.PixelHeight)
$bgra.CopyPixels($pixels, $stride, 0)

[uint64]$sumRed = 0
[uint64]$sumGreen = 0
[uint64]$sumBlue = 0
[uint64]$sumAlpha = 0
[uint64]$transparentPixels = 0
$paletteBins = @{}
for ($offset = 0; $offset -lt $pixels.Length; $offset += 4) {
    $blue = [int]$pixels[$offset]
    $green = [int]$pixels[$offset + 1]
    $red = [int]$pixels[$offset + 2]
    $alpha = [int]$pixels[$offset + 3]
    $sumRed += $red
    $sumGreen += $green
    $sumBlue += $blue
    $sumAlpha += $alpha
    if ($alpha -lt 255) {
        $transparentPixels += 1
    }
    if ($alpha -ge 16) {
        $bin = '{0:X1}{1:X1}{2:X1}' -f ($red -shr 4), ($green -shr 4), ($blue -shr 4)
        if ($paletteBins.ContainsKey($bin)) {
            $paletteBins[$bin] += 1
        } else {
            $paletteBins[$bin] = 1
        }
    }
}

$sampleCount = [uint64]($pixels.Length / 4)
$dominantColors = @(
    $paletteBins.GetEnumerator() |
        Sort-Object Value -Descending |
        Select-Object -First 5 |
        ForEach-Object {
            $redCenter = ([Convert]::ToInt32($_.Key.Substring(0, 1), 16) * 16) + 8
            $greenCenter = ([Convert]::ToInt32($_.Key.Substring(1, 1), 16) * 16) + 8
            $blueCenter = ([Convert]::ToInt32($_.Key.Substring(2, 1), 16) * 16) + 8
            [ordered]@{
                hex = '#{0:X2}{1:X2}{2:X2}' -f $redCenter, $greenCenter, $blueCenter
                sampleCount = [int]$_.Value
            }
        }
)

$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$relativeFramePath = [System.IO.Path]::GetRelativePath($workspaceRoot, $framePath).Replace('\', '/')
$averageRed = [int][Math]::Round($sumRed / $sampleCount)
$averageGreen = [int][Math]::Round($sumGreen / $sampleCount)
$averageBlue = [int][Math]::Round($sumBlue / $sampleCount)
$averageColor = '#{0:X2}{1:X2}{2:X2}' -f $averageRed, $averageGreen, $averageBlue
$report = [ordered]@{
    schema = 'aect-inspection-report/v1'
    runId = $RunId
    frameRelativePath = $relativeFramePath
    createdAtEpochMs = $timestamp
    file = [ordered]@{
        byteLength = $frameInfo.Length
        sha256 = (Get-FileHash -LiteralPath $framePath -Algorithm SHA256).Hash.ToLowerInvariant()
        pngSignatureValid = $true
    }
    image = [ordered]@{
        width = $width
        height = $height
        pixelCount = $pixelCount
        bitDepth = [int]$header[24]
        colorType = [int]$header[25]
        interlaceMethod = [int]$header[28]
        sampledWidth = $bgra.PixelWidth
        sampledHeight = $bgra.PixelHeight
        averageColor = $averageColor
        averageAlpha = [Math]::Round($sumAlpha / $sampleCount, 2)
        hasTransparency = ($transparentPixels -gt 0)
        transparentSampleRatio = [Math]::Round($transparentPixels / $sampleCount, 4)
        dominantColorsApproximate = $dominantColors
    }
    visualReview = [ordered]@{
        verified = $false
        state = $(if ($VisualReviewErrorCode) { 'unavailable' } else { 'pending' })
        errorCode = $VisualReviewErrorCode
        message = $(if ($VisualReviewErrorMessage) { $VisualReviewErrorMessage } elseif ($VisualReviewErrorCode) { 'Pixel-level visual review failed or was unavailable.' } else { 'Frame captured; open frameRelativePath with view_image to perform visual review.' })
        note = 'Technical metadata is a fallback and must not be presented as pixel-level visual verification.'
    }
    retention = 'manual'
}

$reportName = "technical-report-$timestamp.json"
$reportPath = Join-Path $runFolder $reportName
$report | Add-Member -NotePropertyName reportRelativePath -NotePropertyValue (
    [System.IO.Path]::GetRelativePath($workspaceRoot, $reportPath).Replace('\', '/')
)
$reportJson = $report | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($reportPath, $reportJson, [System.Text.UTF8Encoding]::new($false))
$report | ConvertTo-Json -Depth 8
