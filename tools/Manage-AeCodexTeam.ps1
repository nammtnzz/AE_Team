#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Check,[switch]$SmokeTest,[string]$InstallerPath,[string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'AE_CodexTeam'))
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$packageRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
function Find-TeamDependency([string]$Name) {
    $command=Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if($command){return $command.Source}
    $candidates=@()
    if($Name -eq 'pwsh') {
        $candidates+=@(Join-Path $env:ProgramFiles 'PowerShell/7/pwsh.exe')
        $candidates+=@(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')
    }
    if($Name -eq 'code') {$candidates+=@(Join-Path $env:LOCALAPPDATA 'Programs/Microsoft VS Code/bin/code.cmd')}
    foreach($candidate in $candidates){if(Test-Path -LiteralPath $candidate -PathType Leaf){return $candidate}}
    return $null
}
$pwsh=Find-TeamDependency 'pwsh';$node=Find-TeamDependency 'node';$code=Find-TeamDependency 'code'
$product=[IO.File]::ReadAllText((Join-Path $packageRoot 'product.json')) | ConvertFrom-Json
$ready=[bool]($pwsh -and $node -and $code)
if($node){$nodeVersion=& $node -p 'process.versions.node';$ready=$ready -and ([version]$nodeVersion -ge [version]'20.0')}
if($Check){[pscustomobject]@{product='AE_CodexTeam';version=$product.version;state=$(if($ready){'ready'}else{'missing-dependencies'});node=$node;powerShell7=$pwsh;visualStudioCode=$code;installRoot=$InstallRoot} | ConvertTo-Json;exit 0}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object Windows.Forms.Form
$form.Text='AE_CodexTeam · Cài đặt & kết nối';$form.Size=New-Object Drawing.Size(900,710);$form.MinimumSize=$form.Size
$form.StartPosition='CenterScreen';$form.BackColor=[Drawing.Color]::FromArgb(22,25,34);$form.ForeColor=[Drawing.Color]::FromArgb(237,240,249)
$form.Font=New-Object Drawing.Font('Segoe UI',10)
function Add-TeamLabel([string]$Text,[int]$X,[int]$Y,[int]$Width,[int]$Height,[int]$Size=10) {
    $label=New-Object Windows.Forms.Label;$label.Text=$Text;$label.Location=New-Object Drawing.Point($X,$Y);$label.Size=New-Object Drawing.Size($Width,$Height)
    $label.Font=New-Object Drawing.Font('Segoe UI',$Size);$form.Controls.Add($label);return $label
}
$title=Add-TeamLabel 'AE_CodexTeam' 30 24 650 45 25
$subtitle=Add-TeamLabel ('Bộ cài hợp nhất · v'+$product.version+' · 9 vai trò tiếng Việt') 32 76 800 28 11
$features=Add-TeamLabel 'Office 3D   /   Bảng việc   /   Kết quả   /   Timeline   /   Luồng việc   /   Thống kê   /   AE + FX/SFX' 32 116 810 38
$dependency=Add-TeamLabel ('Node.js: '+$(if($node){'có'}else{'thiếu'})+'     PowerShell 7: '+$(if($pwsh){'có'}else{'thiếu'})+'     VS Code: '+$(if($code){'có'}else{'thiếu'})+'     After Effects: cần mở panel để kết nối') 32 158 810 42
$location=Add-TeamLabel ('Cài cho người dùng hiện tại: '+$InstallRoot) 32 204 810 26
$install=New-Object Windows.Forms.Button;$install.Text='Cài đặt / Cập nhật';$install.Location=New-Object Drawing.Point(32,244);$install.Size=New-Object Drawing.Size(215,46);$install.Enabled=$ready
$install.FlatStyle='Flat';$install.BackColor=[Drawing.Color]::FromArgb(102,76,176);$form.Controls.Add($install)
$verify=New-Object Windows.Forms.Button;$verify.Text='Kiểm tra kết nối AE';$verify.Location=New-Object Drawing.Point(263,244);$verify.Size=New-Object Drawing.Size(215,46);$verify.FlatStyle='Flat';$form.Controls.Add($verify)
$open=New-Object Windows.Forms.Button;$open.Text='Mở VS Code';$open.Location=New-Object Drawing.Point(494,244);$open.Size=New-Object Drawing.Size(170,46);$open.FlatStyle='Flat';$form.Controls.Add($open)
$status=Add-TeamLabel 'Chưa kiểm tra kết nối' 32 312 810 52 13
$status.ForeColor=[Drawing.Color]::FromArgb(247,196,107)
$note=Add-TeamLabel 'Cập nhật tự dọn mã bản cũ sau khi xác minh. Dữ liệu được giữ trong retired-data. Bản còn được AE/MCP dùng sẽ dọn ở lần mở bộ cài sau, khi đã rảnh.' 32 373 810 50
$log=New-Object Windows.Forms.TextBox;$log.Multiline=$true;$log.ReadOnly=$true;$log.ScrollBars='Vertical';$log.Location=New-Object Drawing.Point(32,435);$log.Size=New-Object Drawing.Size(810,205)
$log.BackColor=[Drawing.Color]::FromArgb(15,18,25);$log.ForeColor=$form.ForeColor;$form.Controls.Add($log)
$script:child=$null;$script:resultPath=$null;$script:logPath=$null
function Update-TeamConnection {
    if(-not $node){$status.Text='Cần Node.js 20+ để kiểm tra';return}
    try {
        $text=& $node (Join-Path $PSScriptRoot 'TeamStatus.cjs') $InstallRoot
        $info=($text -join "`n") | ConvertFrom-Json
        $status.Text=$info.message
        $status.ForeColor=if($info.state -eq 'connected'){[Drawing.Color]::FromArgb(111,220,168)}else{[Drawing.Color]::FromArgb(247,196,107)}
        $log.Text=($info | ConvertTo-Json -Depth 8)
    } catch {$status.Text='Chưa kiểm tra được: '+$_.Exception.Message}
}
$verify.Add_Click({Update-TeamConnection})
$open.Add_Click({if($code){Start-Process -FilePath $code -WindowStyle Hidden}})
$timer=New-Object Windows.Forms.Timer;$timer.Interval=400
$timer.Add_Tick({
    if(-not $script:child){return}
    if($script:logPath -and (Test-Path -LiteralPath $script:logPath)) {
        try{$lines=Get-Content -LiteralPath $script:logPath -Tail 100;$log.Text=$lines -join "`r`n";$log.SelectionStart=$log.Text.Length;$log.ScrollToCaret()}catch{}
    }
    if($script:child.HasExited){
        $timer.Stop();$install.Enabled=$ready;$verify.Enabled=$true
        try {
            $result=[IO.File]::ReadAllText($script:resultPath) | ConvertFrom-Json
            $log.Text=$result | ConvertTo-Json -Depth 8
            $status.Text=if($result.state -eq 'success'){'Cài đặt hoàn tất. Tải lại VS Code/MCP và mở lại panel AE rồi kiểm tra kết nối.'}else{'Chưa hoàn tất: '+$result.error}
        }catch{$status.Text='Bộ cài chưa trả kết quả. Xem log; không tự chạy lại tác vụ AE.'}
        $script:child.Dispose();$script:child=$null
    }
})
$install.Add_Click({
    try {
        $requestDir=Join-Path $InstallRoot '.ae-codex/setup';[IO.Directory]::CreateDirectory($requestDir) | Out-Null
        $id=[guid]::NewGuid().ToString('N');$script:resultPath=Join-Path $requestDir ('team-'+$id+'.json');$script:logPath=Join-Path $requestDir ('team-'+$id+'.log')
        $args=@('-NoLogo','-NoProfile','-File',('"'+(Join-Path $PSScriptRoot 'Install-AeCodexTeam.ps1')+'"'),'-InstallRoot',('"'+$InstallRoot+'"'),'-ResultPath',('"'+$script:resultPath+'"'))
        if($InstallerPath){$args+=@('-InstallerPath',('"'+$InstallerPath+'"'))}
        $script:child=Start-Process -FilePath $pwsh -ArgumentList $args -WindowStyle Hidden -RedirectStandardError $script:logPath -PassThru
        $install.Enabled=$false;$verify.Enabled=$false;$status.Text='Đang xác minh và cập nhật AE_CodexTeam…';$timer.Start()
    }catch{$status.Text=$_.Exception.Message}
})
$form.Add_FormClosing({param($sender,$eventArgs) if($script:child -and -not $script:child.HasExited){$eventArgs.Cancel=$true;$status.Text='Đang cài đặt. Chờ kết quả trước khi đóng.'}})
$form.Add_Shown({
    Update-TeamConnection
    # One maintenance pass per manager launch, never an idle polling loop.
    if(-not $SmokeTest -and $pwsh -and (Test-Path -LiteralPath (Join-Path $InstallRoot 'installation.json'))){
        try {
            $cleanupScript=Join-Path $PSScriptRoot 'Cleanup-AeCodexTeam.ps1'
            $cleanup=& $pwsh -NoProfile -File $cleanupScript -InstallRoot $InstallRoot
            $log.AppendText("`r`n"+($cleanup -join "`r`n"))
        }catch{$log.AppendText("`r`nDọn bản cũ tạm hoãn: "+$_.Exception.Message)}
    }
    if($SmokeTest){$form.Close()}
})
try{[void]$form.ShowDialog()}finally{$timer.Dispose();$form.Dispose()}
