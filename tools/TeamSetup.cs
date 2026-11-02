using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Diagnostics;
using System.Windows.Forms;

// Single-file offline payload. No downloads, project edits or privileged installation.
internal static class TeamSetup {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4194304 };
    [STAThread] static int Main(string[] args) {
        bool check = args.Length == 1 && args[0] == "--check";
        bool smoke = args.Length == 1 && args[0] == "--smoke-test";
        if (args.Length != 0 && !check && !smoke) return 3;
        string staging = null;
        try {
            staging = Path.Combine(Path.GetTempPath(), "AE_CodexTeam-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(staging);
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("TeamPayload"))
            using (var zip = new ZipArchive(resource, ZipArchiveMode.Read)) {
                foreach (var entry in zip.Entries) {
                    string destination = SafePath(staging, entry.FullName);
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(destination); continue; }
                    using (var input = entry.Open()) using (var output = new FileStream(destination, FileMode.CreateNew)) input.CopyTo(output);
                }
            }
            var manifest = Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(staging,"product.json")));
            if ((string)manifest["schema"] != "ae-codexteam-package/v1") throw new InvalidDataException("Invalid product manifest");
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Dictionary<string,object> file in (IEnumerable)manifest["files"]) {
                string relative = (string)file["path"], target = SafePath(staging,relative);
                if (!seen.Add(relative) || new FileInfo(target).Length != Convert.ToInt64(file["bytes"]) || Hash(target) != (string)file["sha256"])
                    throw new InvalidDataException("Payload checksum mismatch: " + relative);
            }
            foreach (string file in Directory.GetFiles(staging,"*",SearchOption.AllDirectories)) {
                string relative = file.Substring(staging.Length+1).Replace('\\','/');
                if (relative != "product.json" && !seen.Contains(relative)) throw new InvalidDataException("Unexpected payload file");
            }
            if (check) return 0;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using(var manager=new ProductManager(staging,Application.ExecutablePath,Convert.ToString(manifest["version"]),smoke)) Application.Run(manager);
            return 0;
        } catch(Exception e) {
            if (!check && !smoke) MessageBox.Show("Không mở được AE_CodexTeam.\n"+e.Message,"AE_CodexTeam",MessageBoxButtons.OK,MessageBoxIcon.Error);
            else Console.Error.WriteLine(e.Message);
            return 1;
        } finally {
            if (staging != null) {
                try {
                    string root=Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\')+Path.DirectorySeparatorChar;
                    if (staging.StartsWith(root,StringComparison.OrdinalIgnoreCase) && Path.GetFileName(staging).StartsWith("AE_CodexTeam-")) {
                        AssertPlainTree(staging); Directory.Delete(staging,true);
                    }
                } catch { /* Preserve temporary data rather than follow a changed path. */ }
            }
        }
    }
    static string SafePath(string root,string relative) {
        if (String.IsNullOrEmpty(relative) || relative.Contains("\\") || relative.Contains(":") || Path.IsPathRooted(relative)) throw new InvalidDataException("Unsafe archive path");
        foreach(string part in relative.Split('/')) if (part==".." || part==".") throw new InvalidDataException("Unsafe archive traversal");
        string full=Path.GetFullPath(Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar)));
        if (!full.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Archive path escaped root");
        return full;
    }
    static string Hash(string path) { using(var sha=SHA256.Create()) using(var stream=File.OpenRead(path)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
    static void AssertPlainTree(string root) {
        if ((File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0) throw new IOException("Linked temporary folder");
        foreach(string entry in Directory.GetFileSystemEntries(root)) {
            if ((File.GetAttributes(entry)&FileAttributes.ReparsePoint)!=0) throw new IOException("Linked temporary entry");
            if (Directory.Exists(entry)) AssertPlainTree(entry);
        }
    }
}
