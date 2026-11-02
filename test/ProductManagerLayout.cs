using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

// Offline fixture for the WinForms Product Manager. It exercises authored layout only;
// smoke=true prevents status/cleanup/install work from being dispatched.
internal static class ProductManagerLayout {
    static int checks;
    static void Check(bool value, string message) {
        if (!value) throw new InvalidOperationException(message);
        checks++;
    }
    static T Field<T>(Form form, string name) {
        var field = typeof(ProductManager).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic);
        if (field == null) throw new MissingFieldException(typeof(ProductManager).FullName, name);
        return (T)field.GetValue(form);
    }
    static IEnumerable<Control> Controls(Control parent) {
        foreach (Control child in parent.Controls) {
            yield return child;
            foreach (var nested in Controls(child)) yield return nested;
        }
    }
    static Button Button(Form form, string text) {
        foreach (var control in Controls(form)) { var button=control as Button; if (button!=null && button.Text==text) return button; }
        throw new InvalidOperationException("Missing button: " + text);
    }
    static Rectangle BoundsIn(Control control, Control ancestor) {
        return ancestor.RectangleToClient(control.Parent.RectangleToScreen(control.Bounds));
    }
    static void CheckFooter(Form form) {
        var buttons = new[] { Button(form, "Cài đặt"), Button(form, "Mở Team Studio"), Button(form, "Đóng") };
        foreach (var button in buttons) {
            Check(button.Visible, "Footer button is hidden: " + button.Text);
            Check(form.ClientRectangle.Contains(BoundsIn(button,form)), "Footer button is outside the form: " + button.Text);
            Check(button.GetPreferredSize(Size.Empty).Width<=button.Width, "Footer text is clipped: " + button.Text);
        }
        for (var i = 0; i < buttons.Length; i++) for (var j = i + 1; j < buttons.Length; j++)
            Check(!BoundsIn(buttons[i],form).IntersectsWith(BoundsIn(buttons[j],form)), "Footer buttons overlap.");
    }
    static void CheckSize(Form form, int width, int height) {
        form.ClientSize = new Size(width, height);
        form.PerformLayout();
        Check(form.ClientSize.Width >= width && form.ClientSize.Height >= height, "Form shrank below requested client size.");
        CheckFooter(form);
        foreach (var name in new[] { "bannerTitle", "bannerText", "engineState", "teamState", "dependencyState" }) {
            var label=Field<Label>(form,name);
            Check(label.GetPreferredSize(new Size(label.Width,0)).Height<=label.Height, "Status text is clipped: " + name);
            Check(label.Parent.ClientRectangle.Contains(label.Bounds), "Status is outside its parent: " + name);
        }
    }
    [STAThread]
    static int Main() {
        try {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var payload = Path.Combine(Path.GetTempPath(), "ae-team-layout-fixture-" + Guid.NewGuid().ToString("N"));
            using (var form = new ProductManager(payload, Path.Combine(payload, "setup.exe"), "fixture", true)) {
                form.CreateControl();
                form.PerformLayout();
                Check(form.ClientSize.Width == 780 && form.ClientSize.Height == 550, "Unexpected compact default client size.");
                Check(form.MinimumSize.Width == 740 && form.MinimumSize.Height == 540, "Unexpected minimum client size.");
                Check(!Field<Control>(form, "details").Visible, "Details should start collapsed.");
                // Show the authored form without pumping the smoke close callback yet.
                form.ShowInTaskbar=false;form.StartPosition=FormStartPosition.Manual;form.Location=new Point(-2000,-2000);
                form.Show();
                form.PerformLayout();
                CheckFooter(form);

                var toggle = Field<Button>(form, "detailsToggle");
                var before = form.ClientSize;
                toggle.PerformClick();
                form.PerformLayout();
                var details = Field<Control>(form, "details");
                var log = Field<TextBox>(form, "log");
                Check(details.Visible, "Details did not open.");
                Check(form.ClientSize == before, "Opening details must not resize the window.");
                Check(log.ReadOnly && log.Visible && log.Height >= 100, "Diagnostic log is not readable when details are open.");
                Check(log.Width >= details.ClientSize.Width - 40, "Diagnostic log does not use the details width.");
                var scrollable = false;
                foreach (var control in Controls(form)) { var sc=control as ScrollableControl; if(sc!=null && sc.AutoScroll) { scrollable=true;sc.ScrollControlIntoView(log);Check(BoundsIn(log,sc).IntersectsWith(sc.ClientRectangle),"Diagnostic log is unreachable by scrolling."); } }
                Check(scrollable, "Compact body is not scrollable when details are expanded.");
                CheckFooter(form);

                toggle.PerformClick();form.PerformLayout();
                Check(!details.Visible && form.ClientSize==before,"Collapsing details must hide them without resizing.");
                CheckSize(form, 740, 540);
                // Scale the authored controls to approximate a 150% DPI layout and reflow.
                form.Scale(new SizeF(1.5f, 1.5f));
                form.PerformLayout();
                CheckFooter(form);
                Check(log.ReadOnly, "Diagnostic log became editable after scaling.");
                Application.DoEvents();
            }
            Console.WriteLine("{\"state\":\"success\",\"checks\":" + checks + "}");
            return 0;
        } catch (Exception error) {
            Console.WriteLine("{\"state\":\"error\",\"checks\":" + checks + ",\"error\":" + JsonEscape(error.ToString()) + "}");
            return 1;
        }
    }
    static string JsonEscape(string text) {
        return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
    }
}
