$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Z2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> Rows(uint[] pids) {
    var rows = new List<string>(); int idx = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool isApp = Array.IndexOf(pids, pid) >= 0;
      if (!isApp) { if (IsWindowVisible(h)) idx++; return true; }
      int ex = GetWindowLong(h, -20);
      int st = GetWindowLong(h, -16);
      var sb = new StringBuilder(80); GetWindowText(h, sb, 80);
      RECT r; GetWindowRect(h, out r);
      rows.Add(String.Format("APP#{0} visible={1} topmost={2} layered={3} tool={4} wsVisible={5} rect={6},{7} {8}x{9} title='{10}'",
        idx, IsWindowVisible(h), (ex & 0x8) != 0, (ex & 0x80000) != 0, (ex & 0x80) != 0, (st & 0x10000000) != 0,
        r.L, r.T, r.R - r.L, r.B - r.T, sb.ToString()));
      idx++;
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@
Add-Type -TypeDefinition $sig
$pids = [uint32[]]@((Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DSH Whale*' }).Id)
"app pids: $($pids -join ',')"
"=== 我们的窗口在 Z 序里的位置 ==="
[Z2]::Rows($pids)
