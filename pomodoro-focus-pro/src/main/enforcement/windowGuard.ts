import { BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import type { DistractionPolicy } from '../../shared/types'
import type { LockLevel } from '../../shared/settings'
import { LEVEL_CAPS } from './level'

/**
 * 窗口守卫（方案 2.5）：
 * - 分心应用强关：tasklist 枚举带窗进程 → 黑名单且非白名单 → taskkill /F
 * - 前台拉回：本窗口失焦后 400ms 自动拉回（blur → focus）
 * 系统关键进程与自身永不结束。
 */

const NEVER_KILL = new Set([
  'electron',
  'pomodoro-focus-pro',
  'explorer',
  'svchost',
  'csrss',
  'winlogon',
  'services',
  'dwm',
  'lsass'
])

function normalize(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, '').trim()
}

/** 枚举当前有可见窗口的进程名 */
function listWindowProcessNames(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('tasklist', ['/FI', 'WINDOWTITLE ne N/A', '/FO', 'CSV', '/NH'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', () => {
      const names = out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const m = line.match(/^"([^"]+)"/)
          return m ? normalize(m[1]) : ''
        })
        .filter(Boolean)
      resolve(names)
    })
  })
}

export interface WindowGuardStartOpts {
  /**
   * 失焦拉回豁免：聚焦窗口命中时（如 B 站悬浮面板）不拉回本窗口。
   * 用于悬浮面板交互场景——点击面板（AI 输入 / 记事本）时视频窗口会失焦，
   * 若不豁免会被 400ms 后 show()+focus() 抢回焦点并置前，导致面板不可用。
   */
  exemptFromPullBack?: (focused: BrowserWindow | null) => boolean
}

export class WindowGuard {
  private killTimer: NodeJS.Timeout | null = null
  private blurHandler: (() => void) | null = null
  private policy: DistractionPolicy = { enabled: false, blacklist: [], whitelist: [] }
  private win: BrowserWindow | null = null

  /** 启动守卫（level 决定是否启用各能力；policy 来自渲染层配置） */
  start(win: BrowserWindow, level: LockLevel, policy: DistractionPolicy, opts?: WindowGuardStartOpts): void {
    this.win = win
    this.policy = {
      enabled: policy.enabled === true,
      blacklist: (policy.blacklist ?? []).map(normalize),
      whitelist: (policy.whitelist ?? []).map(normalize)
    }

    const caps = LEVEL_CAPS[level]

    if (caps.killDistractions && this.policy.enabled && !this.killTimer) {
      this.killTimer = setInterval(() => {
        void this.killCheck()
      }, 2000)
    }

    if (caps.pullBackForeground && !this.blurHandler) {
      this.blurHandler = (): void => {
        // 失焦 400ms 后拉回（紧急退出弹窗期间由渲染层暂停）
        setTimeout(() => {
          const w = this.win
          if (w && !w.isDestroyed() && !w.isFocused()) {
            // 聚焦窗口命中豁免（如悬浮面板）→ 不拉回，避免抢走面板交互
            if (opts?.exemptFromPullBack?.(BrowserWindow.getFocusedWindow())) return
            w.show()
            w.focus()
          }
        }, 400)
      }
      win.on('blur', this.blurHandler)
    }
  }

  stop(): void {
    if (this.killTimer) {
      clearInterval(this.killTimer)
      this.killTimer = null
    }
    if (this.blurHandler && this.win && !this.win.isDestroyed()) {
      this.win.removeListener('blur', this.blurHandler)
      this.blurHandler = null
    }
    this.win = null
  }

  private async killCheck(): Promise<void> {
    if (!this.policy.enabled || !this.win) return
    let names: string[]
    try {
      names = await listWindowProcessNames()
    } catch {
      return
    }
    for (const name of names) {
      if (this.policy.blacklist.includes(name) && !this.policy.whitelist.includes(name)) {
        this.killProcess(name)
      }
    }
  }

  private killProcess(name: string): void {
    if (NEVER_KILL.has(name)) return
    spawn('taskkill', ['/F', '/IM', `${name}.exe`], { stdio: 'ignore', windowsHide: true }).unref()
  }
}
