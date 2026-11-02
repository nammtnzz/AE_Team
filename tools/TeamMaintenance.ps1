# Shared setup safety. Dot-source only; no code runs on import.
Set-StrictMode -Version Latest
function Assert-TeamPlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked path refused: $cursor" }
        $parent = [IO.Directory]::GetParent($cursor); if ($null -eq $parent) { break }; $cursor = $parent.FullName
    }
}
function Test-TeamChild([string]$Child,[string]$Parent) {
    return [IO.Path]::GetFullPath($Child).StartsWith([IO.Path]::GetFullPath($Parent).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
}
function Read-TeamJson([string]$Path) {
    Assert-TeamPlainPath $Path
    if ((Get-Item -LiteralPath $Path).Length -gt 4194304) { throw "Metadata too large: $Path" }
    return [IO.File]::ReadAllText($Path) | ConvertFrom-Json
}
function Assert-TeamIdle([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    Assert-TeamPlainPath $Root
    foreach ($relative in @('.ae-codex/bridge/submit.lock','.ae-codex/active.lock')) {
        $file = Join-Path $Root $relative; Assert-TeamPlainPath $file
        if (Test-Path -LiteralPath $file) { throw "AE còn khóa công việc; kiểm tra kết quả trước khi cập nhật: $file" }
    }
    foreach ($relative in @('.ae-codex/bridge/inbox','.ae-codex/bridge/running')) {
        $dir = Join-Path $Root $relative; Assert-TeamPlainPath $dir
        if ((Test-Path -LiteralPath $dir) -and @(Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.Name -match '\.(job|running)$' }).Count) { throw "AE còn yêu cầu chưa kết thúc: $dir" }
    }
    $results = Join-Path $Root '.ae-codex/bridge/results'; Assert-TeamPlainPath $results
    if (Test-Path -LiteralPath $results) {
        foreach ($started in Get-ChildItem -LiteralPath $results -Filter 'started-*.json' -File) {
            $terminal = Join-Path $results ($started.Name -replace '^started-','status-')
            if (-not (Test-Path -LiteralPath $terminal)) {
                $run = Read-TeamJson $started.FullName
                $confirmation = Join-Path $Root ('.ae-codex/setup/reconciled-' + $run.runId + '.json')
                $resolved = $false
                if (Test-Path -LiteralPath $confirmation) {
                    $record = Read-TeamJson $confirmation
                    $resolved = $record.schema -eq 'ae-codexteam-reconciliation/v1' -and $record.runId -ceq $run.runId -and
                        $record.startedSha256 -ceq (Get-FileHash -LiteralPath $started.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -and
                        $record.confirmation -eq 'Read-only run reconciled after verified AE idle; do not replay' -and
                        $record.operation -ceq $run.operation -and $record.evidence.panelReady -eq $true
                }
                if (-not $resolved) { throw "Kết quả AE chưa rõ: $($started.Name). Không chạy lại hoặc xóa khóa." }
            }
        }
    }
    $chat = Join-Path $Root '.ae-codex/chat/state.json'
    if (Test-Path -LiteralPath $chat) {
        $state = Read-TeamJson $chat
        if ($state.schema -notin @('aect-chat-state/v1','codex-ae-chat-state/v1') -or $state.busy -or @($state.pendingRequests).Count -or
            ($state.PSObject.Properties['error'] -and $state.error -and $state.error.code -eq 'TURN_STATE_UNKNOWN')) { throw 'Chat cũ đang bận, chờ duyệt hoặc chưa rõ kết quả. Hãy xử lý trước khi cập nhật.' }
    }
}
function Assert-TeamGuards([string]$AppDataRoot) {
    $dir = Join-Path $AppDataRoot 'Code/User/globalStorage/inwave-local.p0-team/update-guards'; Assert-TeamPlainPath $dir
    if (Test-Path -LiteralPath $dir) {
        foreach ($file in Get-ChildItem -LiteralPath $dir -Filter '*.json' -File) {
            $guard = Read-TeamJson $file.FullName
            if ($guard.schema -ne 'ae-codexteam-update-guard/v1' -or $guard.active -or $guard.inFlight -or $guard.hold -or $guard.pendingApproval) {
                throw 'Team còn tác vụ, plan chờ duyệt hoặc kết quả chưa rõ. Dừng/kiểm tra trong VS Code trước khi cập nhật.'
            }
        }
    }
}
function Remove-TeamOldVersions([string]$InstallRoot,[switch]$Fixture) {
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot); Assert-TeamPlainPath $InstallRoot
    $meta = Read-TeamJson (Join-Path $InstallRoot 'installation.json')
    $versions = Join-Path $InstallRoot 'versions'
    if ($meta.schema -notin @('aect-installation/v1','codex-ae-installation/v1') -or -not (Test-TeamChild $meta.runtimeRoot $versions)) { throw 'Invalid active installation pointer' }
    $activeManifest = Read-TeamJson (Join-Path $meta.runtimeRoot 'distribution.json')
    if ($activeManifest.schema -notin @('aect-distribution/v1','codex-ae-distribution/v1') -or $activeManifest.packageId -cne $meta.packageId) { throw 'Active runtime manifest does not match its pointer' }
    foreach ($file in $activeManifest.files) {
        if ($file.path -match '(^|/)\.{1,2}(/|$)|[:\\]' -or [IO.Path]::IsPathRooted($file.path)) { throw 'Unsafe active manifest path' }
        $target = [IO.Path]::GetFullPath((Join-Path $meta.runtimeRoot $file.path)); Assert-TeamPlainPath $target
        if (-not (Test-TeamChild $target $meta.runtimeRoot) -or -not [IO.File]::Exists($target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $file.sha256) { throw 'Active runtime failed verification; old versions preserved' }
    }
    $removed = @(); $deferred = @(); $preserved = @()
    $processes = @()
    if (-not $Fixture) { $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'AfterFX.exe'" -ErrorAction Stop) }
    foreach ($candidate in Get-ChildItem -LiteralPath $versions -Directory) {
        if ($candidate.FullName -ieq $meta.runtimeRoot -or $candidate.Name -notmatch '^\d+\.\d+\.\d+-[a-f0-9]{12}$') { continue }
        try {
            Assert-TeamPlainPath $candidate.FullName
            Assert-TeamIdle $candidate.FullName
            $heartbeat = Join-Path $candidate.FullName '.ae-codex/bridge/heartbeat.json'
            if (Test-Path -LiteralPath $heartbeat) {
                $h = Read-TeamJson $heartbeat
                if ($h.state -eq 'running' -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$h.timestampEpochMs -lt 30000) { throw 'AE đang dùng bản này; mở lại panel mới trước khi dọn' }
                if ($h.state -eq 'running' -and @($processes | Where-Object Name -eq 'AfterFX.exe').Count) { throw 'AE còn mở; heartbeat cũ có thể đang tạm dừng bởi hộp thoại. Đóng AE trước khi dọn bản này' }
            }
            foreach ($process in $processes) {
                if ($process.CommandLine -and $process.CommandLine.Replace('/','\').IndexOf($candidate.FullName,[StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'MCP/runtime vẫn đang tham chiếu bản cũ; tải lại MCP trước khi dọn' }
            }
            foreach ($property in @('mcpConfigPath','panelPath','startupPath')) {
                if ($meta.PSObject.Properties[$property] -and $meta.$property -and [IO.File]::Exists($meta.$property)) {
                    $reference = [IO.File]::ReadAllText($meta.$property).Replace('\\','\').Replace('/','\')
                    if ($reference.IndexOf($candidate.FullName,[StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Cấu hình/loader vẫn tham chiếu bản cũ; sửa bản cài trước khi dọn' }
                }
            }
            $manifestPath = Join-Path $candidate.FullName 'distribution.json'
            $manifest = Read-TeamJson $manifestPath
            if ($manifest.schema -notin @('aect-distribution/v1','codex-ae-distribution/v1') -or $manifest.packageId -cne $candidate.Name) { throw 'Không có manifest sở hữu hợp lệ' }
            # Check every descendant for reparse points before any directory move.
            $queue = [Collections.Generic.Queue[string]]::new(); $queue.Enqueue($candidate.FullName)
            while ($queue.Count) {
                foreach ($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
                    Assert-TeamPlainPath $item.FullName
                    if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
                }
            }
            $program = @()
            foreach ($file in $manifest.files) {
                if ($file.path -match '(^|/)\.{1,2}(/|$)|[:\\]' -or [IO.Path]::IsPathRooted($file.path)) { throw 'Unsafe old manifest path' }
                $target = [IO.Path]::GetFullPath((Join-Path $candidate.FullName $file.path))
                if (-not (Test-TeamChild $target $candidate.FullName)) { throw 'Old path escaped its version' }
                if ([IO.File]::Exists($target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ieq $file.sha256) { $program += $file.path }
            }
            if (-not $Fixture) {
                $lifecycle = Join-Path $meta.runtimeRoot 'tools/AeBackgroundServiceLifecycle.ps1'
                $stopped = & $lifecycle -Action Disable -WorkspaceRoot $candidate.FullName | ConvertFrom-Json
            }
            $recovery = Join-Path $InstallRoot ('retired-data/' + $candidate.Name)
            Assert-TeamPlainPath $recovery
            if (-not (Test-TeamChild $recovery (Join-Path $InstallRoot 'retired-data')) -or (Test-Path -LiteralPath $recovery)) { throw 'Data preservation target already exists' }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($recovery)) | Out-Null
            # Both absolute paths are verified inside the installation before moving.
            if (-not (Test-TeamChild $candidate.FullName $versions)) { throw 'Invalid retirement source' }
            Move-Item -LiteralPath $candidate.FullName -Destination $recovery
            foreach ($relative in $program) {
                $target = Join-Path $recovery $relative
                Assert-TeamPlainPath $target
                if (-not (Test-TeamChild $target $recovery)) { throw 'Invalid program cleanup target' }
                Remove-Item -LiteralPath $target -Force
            }
            Remove-Item -LiteralPath (Join-Path $recovery 'distribution.json') -Force
            # Empty directories only. Modified files and all non-program data survive.
            Get-ChildItem -LiteralPath $recovery -Directory -Recurse -Force | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
                if (@(Get-ChildItem -LiteralPath $_.FullName -Force).Count -eq 0) { [IO.Directory]::Delete($_.FullName) }
            }
            if (@(Get-ChildItem -LiteralPath $recovery -Force).Count -eq 0) { [IO.Directory]::Delete($recovery) } else { $preserved += $recovery }
            $removed += $candidate.Name
        } catch { $deferred += [pscustomobject]@{version=$candidate.Name;reason=$_.Exception.Message} }
    }
    return [pscustomobject]@{removed=$removed;deferred=$deferred;preservedData=$preserved}
}
