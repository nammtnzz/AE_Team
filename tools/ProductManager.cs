using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;

// Own application UI. Backends run only for an explicit action or launch check.
internal sealed class ProductManager : Form {
    readonly string root, installer, installRoot, version;
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4194304 };
    readonly Color paper = Color.FromArgb(30,32,37), card = Color.FromArgb(39,42,48), blue = Color.FromArgb(80,104,220);
    readonly Label bannerTitle, bannerText, engineState, teamState, nativeState, dependencyState;
    readonly TextBox log;
    readonly Button install, check, openAE, openCode, detailsToggle;
    readonly CheckBox teamChoice;
    readonly TableLayoutPanel details, statusBanner;
    readonly System.Windows.Forms.Timer progressTimer, freshnessTimer;
    Process worker;
    string resultPath;
    string installedState = "not-installed";
    bool working;
    public ProductManager(string payload, string executable, string release, bool smoke) {
        root=payload;installer=executable;version=release;
        installRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AE_CodexTeam");
        Text="AE_CodexTeam · Cài đặt";ClientSize=new Size(780,550);MinimumSize=new Size(740,540);
        StartPosition=FormStartPosition.CenterScreen;BackColor=paper;ForeColor=Color.FromArgb(238,238,242);Font=new Font("Segoe UI",10);
        AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;
        var layout=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=3,Padding=new Padding(24),Margin=Padding.Empty};
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));Controls.Add(layout);
        var header=Stack();header.Margin=new Padding(0,0,0,18);
        AddBlock(header,TextLabel("AE_CodexTeam",21));
        var subtitle=TextLabel("Cài đặt & kết nối  ·  v"+version,10);subtitle.ForeColor=Color.FromArgb(158,169,187);AddBlock(header,subtitle);layout.Controls.Add(header,0,0);
        var viewport=new Panel {Dock=DockStyle.Fill,AutoScroll=true,Margin=Padding.Empty};layout.Controls.Add(viewport,0,1);
        var content=Stack();content.Padding=new Padding(0,0,10,0);viewport.Controls.Add(content);
        statusBanner=new TableLayoutPanel {Dock=DockStyle.Top,AutoSize=true,ColumnCount=2,RowCount=1,BackColor=Color.FromArgb(33,48,69),Padding=new Padding(16),Margin=new Padding(0,0,0,14)};
        statusBanner.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,74));statusBanner.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,26));
        var statusText=Stack();bannerTitle=TextLabel("Đang kiểm tra bản cài…",15);bannerText=TextLabel("Trạng thái và bước tiếp theo sẽ hiện tại đây.",10);bannerText.Margin=new Padding(0,7,14,0);
        AddBlock(statusText,bannerTitle);AddBlock(statusText,bannerText);statusBanner.Controls.Add(statusText,0,0);
        var statusActions=Stack();statusActions.Margin=new Padding(10,0,0,0);check=ActionButton("Kiểm tra AE");openAE=ActionButton("Mở After Effects");openAE.Margin=new Padding(0,7,0,0);AddBlock(statusActions,check);AddBlock(statusActions,openAE);statusBanner.Controls.Add(statusActions,1,0);AddBlock(content,statusBanner);
        var components=Stack();components.BackColor=card;components.Padding=new Padding(14,6,14,6);components.Margin=new Padding(0,0,0,10);
        engineState=ComponentRow(components,"AE Engine");teamState=ComponentRow(components,"Team Studio");AddBlock(content,components);
        dependencyState=TextLabel("Đang kiểm tra thành phần cần thiết…",9);dependencyState.ForeColor=Color.FromArgb(158,169,187);AddBlock(content,dependencyState);
        teamChoice=new CheckBox {Text="Cài / sửa Team Studio trong VS Code",Checked=true,AutoSize=true,Dock=DockStyle.Top,Margin=new Padding(0,12,0,6),ForeColor=ForeColor};AddBlock(content,teamChoice);
        detailsToggle=ActionButton("Chi tiết & chẩn đoán  ▾");detailsToggle.TextAlign=ContentAlignment.MiddleLeft;detailsToggle.FlatAppearance.BorderSize=0;detailsToggle.BackColor=paper;detailsToggle.Margin=new Padding(0,4,0,0);AddBlock(content,detailsToggle);
        details=Stack();details.Visible=false;details.BackColor=card;details.Padding=new Padding(14);details.Margin=new Padding(0,8,0,14);AddBlock(content,details);
        AddBlock(details,TextLabel("Cài đặt & dữ liệu",11));
        AddBlock(details,TextLabel("Thư mục cài cho người dùng hiện tại:\n"+installRoot,9));
        nativeState=TextLabel("Kết nối qua panel ScriptUI. Plugin native .aex chưa triển khai.",9);AddBlock(details,nativeState);
        AddBlock(details,TextLabel("Sau khi cập nhật: tải lại VS Code/MCP và mở lại Window → AE_CodexTeam Bridge trong AE.\nGiữ cấu hình, API key, lịch sử và project. Bản cũ chỉ được dọn khi đã xác minh và không còn tác vụ đang dùng.\nSFX được quét thủ công trong panel AE; model và API key cấu hình trong Team Studio.",9));
        var folders=new FlowLayoutPanel {AutoSize=true,Dock=DockStyle.Top,Margin=new Padding(0,8,0,10)};
        var folder=ActionButton("Mở thư mục cài");folder.AutoSize=true;folder.Dock=DockStyle.None;folder.Margin=new Padding(0,0,8,0);folders.Controls.Add(folder);folder.Click+=(s,e)=>OpenFolder(installRoot);
        var data=ActionButton("Dữ liệu giữ lại");data.AutoSize=true;data.Dock=DockStyle.None;folders.Controls.Add(data);data.Click+=(s,e)=>OpenFolder(Path.Combine(installRoot,"retired-data"));AddBlock(details,folders);
        AddBlock(details,TextLabel("Chẩn đoán",11));
        log=new TextBox {Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Both,WordWrap=false,Dock=DockStyle.Top,Height=180,Margin=new Padding(0,8,0,0),BackColor=Color.FromArgb(23,25,29),ForeColor=ForeColor,Font=new Font("Consolas",9)};AddBlock(details,log);
        var footer=new TableLayoutPanel {Dock=DockStyle.Top,AutoSize=true,ColumnCount=3,RowCount=1,Margin=new Padding(0,16,0,0)};
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,44));footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,36));footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,20));
        install=ActionButton("Cài đặt");install.BackColor=blue;install.Height=44;install.Margin=new Padding(0,0,10,0);footer.Controls.Add(install,0,0);
        openCode=ActionButton("Mở Team Studio");openCode.Height=44;openCode.Margin=new Padding(0,0,10,0);footer.Controls.Add(openCode,1,0);
        var close=ActionButton("Đóng");close.Height=44;footer.Controls.Add(close,2,0);layout.Controls.Add(footer,0,2);
        detailsToggle.Click+=(s,e)=>ToggleDetails();
        install.Click+=async(s,e)=>await Install();check.Click+=async(s,e)=>await RefreshStatus();
        openAE.Click+=(s,e)=>{try{var exe=FindAE();if(exe==null)throw new Exception("Chưa tìm thấy After Effects trong Program Files/Adobe.");Process.Start(new ProcessStartInfo(exe){UseShellExecute=true});}catch(Exception ex){Message(ex.Message);}};
        openCode.Click+=(s,e)=>{try{var exe=Dependency("code");if(exe==null)throw new Exception("Cần cài Visual Studio Code để mở Team Studio.");Process.Start(new ProcessStartInfo(exe){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Hidden});}catch(Exception ex){Message(ex.Message);}};
        close.Click+=(s,e)=>Close();
        progressTimer=new System.Windows.Forms.Timer {Interval=500};progressTimer.Tick+=async(s,e)=>await CheckWorker();
        freshnessTimer=new System.Windows.Forms.Timer();freshnessTimer.Tick+=(s,e)=>{freshnessTimer.Stop();bannerTitle.Text="Cần kiểm tra lại kết nối AE";bannerText.Text="Bấm Kiểm tra AE trước khi gửi công việc.";statusBanner.BackColor=Color.FromArgb(33,48,69);};
        FormClosing+=(s,e)=>{if(working || (worker!=null && !worker.HasExited)){e.Cancel=true;Message("Đang kiểm tra hoặc cập nhật. Chờ kết quả trước khi đóng.");}};
        Shown+=async(s,e)=>{if(smoke){BeginInvoke(new Action(Close));return;}await RefreshStatus();await Cleanup();};
    }
    TableLayoutPanel Stack(){var table=new TableLayoutPanel {Dock=DockStyle.Top,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,ColumnCount=1,RowCount=0,Margin=Padding.Empty};table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));return table;}
    void AddBlock(TableLayoutPanel table,Control control){int row=table.RowCount++;table.RowStyles.Add(new RowStyle(SizeType.AutoSize));table.Controls.Add(control,0,row);}
    Label TextLabel(string text,int size){return new Label {Text=text,UseMnemonic=false,AutoSize=true,Dock=DockStyle.Fill,Font=new Font("Segoe UI",size),ForeColor=ForeColor,Margin=new Padding(0,3,0,3)};}
    Button ActionButton(string text){var button=new Button {Text=text,UseMnemonic=false,Dock=DockStyle.Top,Height=36,FlatStyle=FlatStyle.Flat,BackColor=card,ForeColor=ForeColor,Margin=Padding.Empty,Padding=new Padding(8,0,8,0)};button.FlatAppearance.BorderColor=Color.FromArgb(65,71,82);return button;}
    Label ComponentRow(TableLayoutPanel parent,string title){var row=new TableLayoutPanel {Dock=DockStyle.Top,AutoSize=true,ColumnCount=2,RowCount=1,Margin=new Padding(0,5,0,5)};row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,48));row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,52));row.Controls.Add(TextLabel(title,10),0,0);var value=TextLabel("Chưa kiểm tra",10);value.TextAlign=ContentAlignment.MiddleRight;row.Controls.Add(value,1,0);AddBlock(parent,row);return value;}
    void ToggleDetails(){
        details.Visible=!details.Visible;
        detailsToggle.Text=details.Visible?"Ẩn chi tiết  ▴":"Chi tiết & chẩn đoán  ▾";
    }
    void Message(string message){bannerText.Text=message;}
    static string Quote(string s){if(s==null || s.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new ArgumentException("Invalid command argument");return "\""+s+"\"";}
    public static string Dependency(string name){
        var candidates=new List<string>();string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), home=Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if(name=="pwsh"){candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"PowerShell/7/pwsh.exe"));candidates.Add(Path.Combine(home,".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe"));}
        if(name=="node"){candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"nodejs/node.exe"));candidates.Add(Path.Combine(home,".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"));}
        if(name=="code")candidates.Add(Path.Combine(local,"Programs/Microsoft VS Code/bin/code.cmd"));
        foreach(var dir in (Environment.GetEnvironmentVariable("PATH")??"").Split(';')){if(String.IsNullOrWhiteSpace(dir))continue;try{candidates.Add(Path.Combine(dir.Trim('"'),name+".exe"));candidates.Add(Path.Combine(dir.Trim('"'),name+".cmd"));}catch{}}
        foreach(var file in candidates)if(File.Exists(file))return Path.GetFullPath(file);return null;
    }
    static string FindAE(){var adobe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"Adobe");if(!Directory.Exists(adobe))return null;var dirs=Directory.GetDirectories(adobe,"*After Effects*");Array.Sort(dirs,StringComparer.OrdinalIgnoreCase);Array.Reverse(dirs);foreach(var dir in dirs){var exe=Path.Combine(dir,"Support Files/AfterFX.exe");if(File.Exists(exe))return exe;}return null;}
    static async Task<string> Run(string executable,string arguments,int timeout){
        using(var p=new Process{StartInfo=new ProcessStartInfo(executable,arguments){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=System.Text.Encoding.UTF8,StandardErrorEncoding=System.Text.Encoding.UTF8}}){
            p.Start();var stdout=p.StandardOutput.ReadToEndAsync();var stderr=p.StandardError.ReadToEndAsync();
            if(!await Task.Run(()=>p.WaitForExit(timeout))){try{p.Kill();}catch{}throw new Exception("Kiểm tra quá thời gian. Không gửi lại lệnh AE.");}
            var text=await stdout;var error=await stderr;if(p.ExitCode!=0)throw new Exception(error.Length>1500?error.Substring(0,1500):error);return text;
        }
    }
    async Task RefreshStatus(){
        if(working)return;working=true;UpdateAvailability();freshnessTimer.Stop();bannerTitle.Text="Đang kiểm tra bản cài…";
        try{
            string node=Dependency("node"),pwsh=Dependency("pwsh"),code=Dependency("code");
            dependencyState.Text=node!=null&&pwsh!=null ? (code!=null?"Các thành phần cần thiết đã sẵn sàng.":"Engine sẵn sàng. Cài VS Code nếu muốn dùng Team Studio.") : "Cần cài thêm: "+(node==null?"Node.js 20+ ":"")+(pwsh==null?"PowerShell 7":"");
            if(node==null)throw new Exception("Cần Node.js 20+ cho engine. Trình quản lý vẫn mở được khi AE tắt.");
            var text=await Run(node,Quote(Path.Combine(root,"tools/TeamStatus.cjs"))+" "+Quote(installRoot),15000);
            var info=json.Deserialize<Dictionary<string,object>>(text);log.Text=text;
            string state=Convert.ToString(info["state"]);installedState=state;
            bannerTitle.Text=state=="connected"?"Đã kết nối After Effects":state=="not-installed"?"Sẵn sàng cài đặt":state=="repair-required"?"Bản cài cần sửa chữa":"Đã cài · AE chưa kết nối";
            statusBanner.BackColor=state=="connected"?Color.FromArgb(32,64,52):state=="repair-required"?Color.FromArgb(74,49,38):Color.FromArgb(33,48,69);
            bannerText.Text=Convert.ToString(info["message"]);
            engineState.Text=info.ContainsKey("engineVersion")?"Đã cài v"+info["engineVersion"]:"Chưa cài";
            teamState.Text=info.ContainsKey("teamVersion")&&info["teamVersion"]!=null?"Bản cài ghi nhận v"+info["teamVersion"]:"Chưa ghi nhận";
            if(state=="connected"){
                var c=(Dictionary<string,object>)info["connection"];double age=Convert.ToDouble(c["ageMs"]);
                freshnessTimer.Interval=(int)Math.Max(1,Math.Min(15000,15000-age));freshnessTimer.Start();
            }
        }catch(Exception ex){bannerTitle.Text="Chưa kiểm tra được bản cài";statusBanner.BackColor=Color.FromArgb(74,49,38);Message(ex.Message);log.Text=ex.ToString();}finally{working=false;UpdateAvailability();}
    }
    void UpdateAvailability(){
        bool hasCode=Dependency("code")!=null;
        install.Enabled=!working&&Dependency("node")!=null&&Dependency("pwsh")!=null;
        install.Text=installedState=="not-installed"?"Cài đặt":installedState=="repair-required"?"Sửa bản cài":"Cập nhật / Sửa chữa";
        check.Enabled=!working;teamChoice.Enabled=!working&&hasCode;if(!hasCode)teamChoice.Checked=false;
        openCode.Enabled=hasCode;openAE.Enabled=FindAE()!=null;
    }
    async Task Cleanup(){
        var pwsh=Dependency("pwsh");if(pwsh==null||!File.Exists(Path.Combine(installRoot,"installation.json")))return;
        working=true;UpdateAvailability();
        try{var text=await Run(pwsh,"-NoProfile -File "+Quote(Path.Combine(root,"tools/Cleanup-AeCodexTeam.ps1"))+" -InstallRoot "+Quote(installRoot),30000);log.AppendText(Environment.NewLine+text);}catch(Exception ex){log.AppendText(Environment.NewLine+"Hoãn dọn bản cũ: "+ex.Message);}finally{working=false;UpdateAvailability();}
    }
    async Task Install(){
        if(working||worker!=null)return;
        try{
            var pwsh=Dependency("pwsh");if(pwsh==null)throw new Exception("Cần PowerShell 7 để cài engine.");
            string dir=Path.Combine(installRoot,".ae-codex/setup");Directory.CreateDirectory(dir);string id=Guid.NewGuid().ToString("N");resultPath=Path.Combine(dir,"team-"+id+".json");
            string args="-NoProfile -File "+Quote(Path.Combine(root,"tools/Install-AeCodexTeam.ps1"))+" -InstallRoot "+Quote(installRoot)+" -ResultPath "+Quote(resultPath)+" -InstallerPath "+Quote(installer);
            if(!teamChoice.Checked||Dependency("code")==null)args+=" -SkipTeam";
            var start=new ProcessStartInfo(pwsh,args){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden};
            foreach(var dep in new[]{"node","code","pwsh"}){var file=Dependency(dep);if(file!=null)start.EnvironmentVariables["PATH"]=Path.GetDirectoryName(file)+";"+start.EnvironmentVariables["PATH"];}
            worker=Process.Start(start);
            working=true;UpdateAvailability();freshnessTimer.Stop();bannerTitle.Text="Đang xác minh và cập nhật…";Message("Giữ cửa sổ này mở đến khi cài đặt hoàn tất.");progressTimer.Start();
            await Task.FromResult(0);
        }catch(Exception ex){Message(ex.Message);}
    }
    async Task CheckWorker(){
        if(worker==null)return;
        if(!worker.HasExited)return;
        progressTimer.Stop();worker.Dispose();worker=null;working=false;
        try{
            var text=File.ReadAllText(resultPath);var r=json.Deserialize<Dictionary<string,object>>(text);
            await RefreshStatus();log.Text=text+Environment.NewLine+log.Text;
            if(Convert.ToString(r["state"])=="success")Message("Cập nhật hoàn tất. Tải lại VS Code/MCP và mở lại panel AE_CodexTeam Bridge trong AE.");
            else {bannerTitle.Text="Cập nhật chưa hoàn tất";statusBanner.BackColor=Color.FromArgb(74,49,38);Message(r.ContainsKey("error")?Convert.ToString(r["error"]):Convert.ToString(r["message"]));}
        }catch(Exception ex){bannerTitle.Text="Cần kiểm tra kết quả cài đặt";Message("Chưa nhận được kết quả. Mở Chi tiết & chẩn đoán; không tự chạy lại. "+ex.Message);log.AppendText(Environment.NewLine+ex);}
        finally{UpdateAvailability();}
    }
    void OpenFolder(string dir){try{if(!Directory.Exists(dir)){Message("Chưa có thư mục: "+dir);return;}Process.Start(new ProcessStartInfo("explorer.exe",Quote(dir)){UseShellExecute=true});}catch(Exception ex){Message(ex.Message);}}
    protected override void Dispose(bool disposing){if(disposing){progressTimer.Dispose();freshnessTimer.Dispose();if(worker!=null)worker.Dispose();}base.Dispose(disposing);}
}
