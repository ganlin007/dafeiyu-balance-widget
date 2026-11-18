$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Z {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static List<string> List(uint[] appPids) {
    var rows = new List<string>();
    int idx = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      int ex = GetWindowLong(h, -20);
      var sb = new StringBuilder(80); GetWindowText(h, sb, 80);
      bool isApp = Array.IndexOf(appPids, pid) >= 0;
      bool topmost = (ex & 0x8) != 0;
      bool tool = (ex & 0x80) != 0;
      rows.Add(String.Format("#{0,-3} {1,-10} topmost={2,-5} tool={3,-5} pid={4,-6} {5}",
        idx++, isApp ? "APP" : "other", topmost, tool, pid, sb.ToString()));
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@
Add-Type -TypeDefinition $sig
$appPids = [uint32[]]@((Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DSH Whale*' }).Id)
"app pids: $($appPids -join ',')"
"foreground hwnd pid = " + ([Z]::GetWindowThreadProcessId([Z]::GetForegroundWindow(), [ref]([uint32]0)))
"===== 当前 Z 序（自上而下，前 14 个可见窗口）====="
[Z]::List($appPids) | Select-Object -First 14
