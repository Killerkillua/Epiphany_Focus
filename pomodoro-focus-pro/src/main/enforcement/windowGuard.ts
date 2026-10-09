import { spawn } from 'child_process'
import { BrowserWindow } from 'electron'
import { isWindows, spawnQuiet } from './spawnQuiet'
import type { DistractionPolicy } from '../../shared/types'
import type { LockLevel } from '../../shared/settings'
import { LEVEL_CAPS } from './level'
import { isLevelWindowTransitioning } from './lockScreen'

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
  return name
    .toLowerCase()
    .replace(/\.exe$/, '')
    .trim()
}

/** 枚举当前有可见窗口的进程名 */
function listWindowProcessNames(): Promise<string[]> {
  if (!isWindows()) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const child = spawn('tasklist', ['/FI', 'WINDOWTITLE ne N/A', '/FO', 'CSV', '/NH'], {
      windowsHide: true
    })
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
   * 失焦拉回豁免：聚焦窗口命中时（如 视频学习悬浮面板）不拉回本窗口。
   * 用于悬浮面板交互场景——点击面板（AI 输入 / 记事本）时视频窗口会失焦，
   * 若不豁免会被 400ms 后 show()+focus() 抢回焦点并置前，导致面板不可用。
   */
  exemptFromPullBack?: (focused: BrowserWindow | null) => boolean
}

export class WindowGuard {
  private killTimer: NodeJS.Timeout | null = null
  private blurHandler: (() => void) | null = null
  /** 失焦监听实际挂上的窗口。换目标时必须从这里摘掉，不能只看 this.win */
  private blurTarget: BrowserWindow | null = null
  private policy: DistractionPolicy = { enabled: false, blacklist: [], whitelist: [] }
  private win: BrowserWindow | null = null
  /** 失焦拉回暂停（P-2：紧急退出弹窗期间由渲染层置 true，避免视频窗口抢焦点导致输入不了恢复码） */
  private paused = false

  /** 暂停 / 恢复失焦拉回（紧急退出弹窗打开时暂停、关闭时恢复） */
  setPaused(paused: boolean): void {
    this.paused = paused
  }

  /** 启动守卫（level 决定是否启用各能力；policy 来自渲染层配置） */
  start(
    win: BrowserWindow,
    level: LockLevel,
    policy: DistractionPolicy,
    opts?: WindowGuardStartOpts
  ): void {
    this.win = win
    this.policy = {
      enabled: policy.enabled === true,
      blacklist: (policy.blacklist ?? []).map(normalize),
      whitelist: (policy.whitelist ?? []).map(normalize)
    }

    const caps = LEVEL_CAPS[level]

    if (isWindows() && caps.killDistractions && this.policy.enabled && !this.killTimer) {
      this.killTimer = setInterval(() => {
        void this.killCheck()
      }, 2000)
    }

    if (caps.pullBackForeground) {
      if (this.blurHandler && this.blurTarget !== win) this.unbindBlur()
      if (!this.blurHandler) {
      this.blurTarget = win
      this.blurHandler = (): void => {
        const focusedAtBlur = BrowserWindow.getFocusedWindow()
        // #region agent log
        fetch('http://127.0.0.1:7545/ingest/e2f82ed8-e164-46c1-bb02-7e41a5591a63',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'359fe5'},body:JSON.stringify({sessionId:'359fe5',runId:'pre-fix',hypothesisId:'H2',location:'windowGuard.ts:blur',message:'study window blurred',data:{videoId:win.id,videoFull:win.isFullScreen(),focusedId:focusedAtBlur?.id??null,exempt:opts?.exemptFromPullBack?.(focusedAtBlur)??false,paused:this.paused},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        // 失焦 400ms 后拉回（紧急退出弹窗期间由渲染层暂停，避免抢焦点）
        setTimeout(() => {
          const w = this.win
          if (w && !w.isDestroyed() && !w.isFocused()) {
            if (this.paused) return
            // P2-1：全屏切换过渡期（applyLevelWindow 进入/退出全屏）暂停拉回，
            // 避免 show()+focus() 干扰系统全屏状态正确应用（如任务栏覆盖）
            if (isLevelWindowTransitioning(w)) return
            // 聚焦窗口命中豁免（如悬浮面板）→ 不拉回，避免抢走面板交互
            const focused = BrowserWindow.getFocusedWindow()
            const exempt = opts?.exemptFromPullBack?.(focused) ?? false
            // #region agent log
            fetch('http://127.0.0.1:7545/ingest/e2f82ed8-e164-46c1-bb02-7e41a5591a63',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'359fe5'},body:JSON.stringify({sessionId:'359fe5',runId:'pre-fix',hypothesisId:'H2',location:'windowGuard.ts:blur-timeout',message:'pull-back decision',data:{videoId:w.id,videoFull:w.isFullScreen(),focusedId:focused?.id??null,exempt,willPull:!exempt},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            if (exempt) return
            w.show()
            w.focus()
          }
        }, 400)
        setTimeout(() => {
          const w = this.win
          if (!w || w.isDestroyed()) return
          const focused = BrowserWindow.getFocusedWindow()
          // #region agent log
          fetch('http://127.0.0.1:7545/ingest/e2f82ed8-e164-46c1-bb02-7e41a5591a63',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'359fe5'},body:JSON.stringify({sessionId:'359fe5',runId:'pre-fix',hypothesisId:'H2',location:'windowGuard.ts:blur-followup',message:'focus 1.2s after blur',data:{videoId:w.id,videoFull:w.isFullScreen(),videoFocused:w.isFocused(),focusedId:focused?.id??null,outsideApp:focused===null},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
        }, 1200)
      }
      win.on('blur', this.blurHandler)
      }
    }
  }

  private unbindBlur(): void {
    if (this.blurHandler && this.blurTarget && !this.blurTarget.isDestroyed()) {
      this.blurTarget.removeListener('blur', this.blurHandler)
    }
    this.blurHandler = null
    this.blurTarget = null
  }

  stop(): void {
    if (this.killTimer) {
      clearInterval(this.killTimer)
      this.killTimer = null
    }
    this.unbindBlur()
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
    if (!isWindows() || NEVER_KILL.has(name)) return
    spawnQuiet('taskkill', ['/F', '/IM', `${name}.exe`])
  }
}
