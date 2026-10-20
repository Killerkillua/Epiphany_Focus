import { execFileSync, spawn } from 'child_process'
import { app } from 'electron'
import { isWindows } from './spawnQuiet'

/**
 * Windows 只给「唯一的前台全屏窗口」藏任务栏。
 * 学习助手是另一扇可见窗口，shell 会把任务栏重新亮出来，盖在非置顶的全屏网页上。
 * 全屏锁持有期间直接隐藏 Shell 任务栏，释放时按原状态还原。
 */

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PomodoroTaskbar {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("shell32.dll")] public static extern IntPtr SHAppBarMessage(uint msg, ref APPBARDATA data);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA {
    public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public int lParam;
  }
}
"@
function Set-Bars([int]$cmd) {
  $primary = [PomodoroTaskbar]::FindWindow('Shell_TrayWnd', $null)
  if ($primary -ne [IntPtr]::Zero) { [void][PomodoroTaskbar]::ShowWindow($primary, $cmd) }
  $after = [IntPtr]::Zero
  for ($i = 0; $i -lt 8; $i++) {
    $after = [PomodoroTaskbar]::FindWindowEx([IntPtr]::Zero, $after, 'Shell_SecondaryTrayWnd', $null)
    if ($after -eq [IntPtr]::Zero) { break }
    [void][PomodoroTaskbar]::ShowWindow($after, $cmd)
  }
}
function Set-AppBar([int]$state) {
  $data = New-Object PomodoroTaskbar+APPBARDATA
  $data.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]([PomodoroTaskbar+APPBARDATA]))
  $data.lParam = $state
  [void][PomodoroTaskbar]::SHAppBarMessage(10, [ref]$data)
}
function Get-AppBar() {
  $data = New-Object PomodoroTaskbar+APPBARDATA
  $data.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]([PomodoroTaskbar+APPBARDATA]))
  return [PomodoroTaskbar]::SHAppBarMessage(4, [ref]$data).ToInt64()
}
function Get-Now() {
  $h = [PomodoroTaskbar]::FindWindow('Shell_TrayWnd', $null)
  if ($h -eq [IntPtr]::Zero) { 'missing' } elseif ([PomodoroTaskbar]::IsWindowVisible($h)) { 'visible' } else { 'hidden' }
}
$mode = $env:POMODORO_TASKBAR_MODE
$prev = Get-AppBar
if ($mode -eq 'hide') {
  Set-AppBar (1 -bor 2)
  Set-Bars 0
} elseif ($mode -eq 'show') {
  $restore = 2
  if ($env:POMODORO_TASKBAR_RESTORE -match '^\\d+$') { $restore = [int]$env:POMODORO_TASKBAR_RESTORE }
  Set-AppBar $restore
  Set-Bars 5
}
Write-Output ("prev=" + $prev + ";now=" + (Get-Now))
`

let holders = 0
let savedAppBarState: number | null = null
let chain: Promise<void> = Promise.resolve()

function run(mode: 'hide' | 'show' | 'query'): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
      {
        windowsHide: true,
        env: {
          ...process.env,
          POMODORO_TASKBAR_MODE: mode,
          POMODORO_TASKBAR_RESTORE: savedAppBarState === null ? '' : String(savedAppBarState)
        }
      }
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('error', () => resolve('error'))
    child.on('close', () => resolve(out.trim() || 'empty'))
  })
}

function enqueue(mode: 'hide' | 'show' | 'query'): void {
  chain = chain
    .then(() => run(mode))
    .then((raw) => {
      const prev = Number(raw.match(/prev=(-?\d+)/)?.[1])
      if (mode === 'hide' && savedAppBarState === null && Number.isFinite(prev)) savedAppBarState = prev
      if (mode === 'show') savedAppBarState = null
    })
    .catch(() => undefined)
}

/** 全屏锁开始：藏住 Windows 任务栏 */
export function acquireTaskbarCover(): void {
  if (!isWindows()) return
  holders += 1
  if (holders === 1) enqueue('hide')
}

/** 学习助手显示后 shell 常会把任务栏亮回来，持有期间再藏一次 */
export function reinforceTaskbarCover(): void {
  if (!isWindows() || holders <= 0) return
  enqueue('hide')
}

/** 全屏锁结束：按进入前的状态恢复任务栏 */
export function releaseTaskbarCover(): void {
  if (!isWindows()) return
  holders = Math.max(0, holders - 1)
  if (holders === 0) enqueue('show')
}

function restoreTaskbarSync(): void {
  if (!isWindows() || (holders === 0 && savedAppBarState === null)) return
  const restore = savedAppBarState ?? 2
  holders = 0
  savedAppBarState = null
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
      {
        windowsHide: true,
        timeout: 8000,
        env: {
          ...process.env,
          POMODORO_TASKBAR_MODE: 'show',
          POMODORO_TASKBAR_RESTORE: String(restore)
        }
      }
    )
  } catch {
    /* 退出时尽力还原 */
  }
}

app.on('will-quit', () => restoreTaskbarSync())
process.on('exit', () => restoreTaskbarSync())
