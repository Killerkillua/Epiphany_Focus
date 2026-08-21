import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { spawn } from 'child_process'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { IPC_CHANNELS, IPC_EVENTS } from '../ipc'
import { TimerService } from '../timer'
import { getSettings, setSettings } from '../storage/settings'
import {
  recordSessionEnd,
  recordSessionStart,
  recordStudyStats,
  todayLocal
} from '../storage/db'
import { LEVEL_CAPS } from './level'
import * as emergency from './emergencyExit'
import { registerShortcutGuard, unregisterShortcutGuard } from './shortcutGuard'
import { WindowGuard } from './windowGuard'
import { startTaskmgrKill, stopTaskmgrKill } from './processGuard'
import { applyLevelWindow, releaseLevelWindow, lockWorkstation } from './lockScreen'
import { closeVideo } from '../navigation/biliWindow'
import type { DistractionPolicy, TimerOptions, TimerSnapshot } from '../../shared/types'
import type { EmergencyExitResult, LockLevel } from '../../shared/settings'

/**
 * 强制引擎（方案 2.5/2.10/3.3）：
 * - 专注会话开始 → 按锁定级别施加强制（遮罩/快捷键/守卫/守护进程）
 * - 会话结束 → 记录 sessions + study_stats
 * - 紧急退出：恢复码 bcrypt 验证 + 冷却 + 会话上限
 * - enforced 状态持久化：重启后自动恢复（防重启绕过）
 */

interface ActiveSession {
  level: LockLevel
  mode: string
  startedAt: number
  sessionId: number
}

const DEFAULT_POLICY: DistractionPolicy = { enabled: false, blacklist: [], whitelist: [] }

/** 强制引擎句柄（供导航模块接入） */
export interface EnforcementHandle {
  restoreAfterRestart: () => void
  /** 打开 B 站视频时启动强制会话（正向计时 + 会话上限） */
  enterBiliSession: (videoWin: BrowserWindow, opts: { plannedMs: number; topic: string }) => void
  /** 关闭 B 站视频时结束强制会话并落库 */
  exitBiliSession: (reason: 'manual' | 'completed' | 'emergency') => void
  /**
   * 登记"失焦拉回豁免"窗口（B 站悬浮面板）：用户与面板交互（点击 / 输入）导致
   * 视频窗口失焦时，不执行 show()+focus() 抢回，保证面板可用。
   */
  setOverlayExempt: (win: BrowserWindow | null) => void
  /**
   * 暂停 / 恢复窗口守卫的失焦拉回（P-2：紧急退出弹窗打开期间暂停，
   * 避免视频窗口把焦点抢回，用户输入不了恢复码）。
   */
  setPullBackPaused: (paused: boolean) => void
}

export function registerEnforcementModule(getWindow: () => BrowserWindow | null): EnforcementHandle {
  const timer = new TimerService(
    (snap) => {
      getWindow()?.webContents.send(IPC_EVENTS.timer.tick, snap)
    },
    (snap) => {
      getWindow()?.webContents.send(IPC_EVENTS.timer.complete, snap)
      onTimerComplete(snap)
    }
  )

  const windowGuard = new WindowGuard()
  let active: ActiveSession | null = null
  let guardian: ReturnType<typeof spawn> | null = null
  let lastPomos = 0
  let currentPolicy: DistractionPolicy = { ...DEFAULT_POLICY }
  /** B 站悬浮面板窗口：失焦拉回豁免对象（面板交互时视频窗口不抢焦点） */
  let overlayExemptWindow: BrowserWindow | null = null

  /** 失焦拉回豁免判定：当前聚焦窗口是悬浮面板时不拉回视频窗口 */
  const overlayExempt = (focused: BrowserWindow | null): boolean =>
    overlayExemptWindow !== null && focused === overlayExemptWindow

  // ================= 强制会话生命周期 =================

  function beginEnforcement(mode: string, plannedMs: number, target?: BrowserWindow): void {
    const level = getSettings().lockLevel
    // L1/L2 前置：必须已设置恢复码（安全兜底，方案 2.10）
    emergency.assertExitSafety(level)

    const win = target ?? getWindow()
    if (!win) return
    const sessionId =
      recordSessionStart({ mode, level, startedAt: Date.now(), durationPlanned: plannedMs }) ?? 0

    // B 站模式：视频窗口不设置置顶（悬浮面板须浮于视频之上；全屏由 attachFullscreenLock 管理），
    // 其余锁定属性（禁缩放 / 隐藏任务栏 / 拦截关闭）照常施加
    applyLevelWindow(win, { skipAlwaysOnTop: mode === 'bili' })
    if (LEVEL_CAPS[level].globalShortcuts) registerShortcutGuard()
    windowGuard.start(win, level, currentPolicy, { exemptFromPullBack: overlayExempt })
    if (LEVEL_CAPS[level].killTaskmgr) startTaskmgrKill()
    if (LEVEL_CAPS[level].guardian) spawnGuardian()

    active = { level, mode, startedAt: Date.now(), sessionId }
    lastPomos = timer.getSnapshot().completedPomodoros
    setSettings({
      enforced: { active: true, level, mode, startedAt: active.startedAt, plannedMs, sessionId }
    })
  }

  function endEnforcement(reason: 'manual' | 'completed' | 'emergency' | 'expired', target?: BrowserWindow): void {
    const win = target ?? getWindow()
    if (active) {
      const after = timer.getSnapshot()
      const status = after.completedPomodoros > lastPomos ? 'done' : 'abandoned'
      recordSessionEnd(active.sessionId, {
        durationActual: after.elapsedMs,
        pomosCompleted: Math.max(0, after.completedPomodoros - lastPomos),
        interruptions: 0,
        status: reason === 'emergency' ? 'emergency_exit' : status
      })
      active = null
    }
    if (win) releaseLevelWindow(win)
    // P-2：紧急退出兜底销毁 B 站视频窗口——video.destroy() 绕过 applyLevelWindow 的
    // close 拦截，销毁后 'closed' 事件自动清理其遮罩引用计数，
    // 避免紧急退出成功后视频窗口仍保持全屏 + 拦截关闭 + 隐藏任务栏，把用户困在全屏
    if (reason === 'emergency') {
      try {
        closeVideo()
      } catch {
        /* 忽略 */
      }
    }
    unregisterShortcutGuard()
    windowGuard.stop()
    stopTaskmgrKill()
    stopGuardian()
    setSettings({ enforced: null })
    if (reason === 'emergency' && LEVEL_CAPS[getSettings().lockLevel].guardian) {
      emergency.startL2CoolDown()
    }
  }

  /** 到点：记录统计 + 按"到点动作"执行（方案 4.2） */
  function onTimerComplete(snap: TimerSnapshot): void {
    // 分钟换算统一在 recordStudyStats 内完成（毫秒入参）
    recordStudyStats(todayLocal(), active?.mode ?? 'focus', snap.elapsedMs, 1)
    lastPomos = snap.completedPomodoros
    if (getSettings().endAction === 'lock') {
      lockWorkstation()
    }
    // overlay：保持全屏遮罩（完成态 UI）；notify：仅通知（已完成推送）
  }

  // ================= L2 守护进程 =================

  function spawnGuardian(): void {
    try {
      if (guardian) return
      const pidFile = join(app.getPath('userData'), 'enforced.pid')
      writeFileSync(pidFile, String(process.pid))
      const script = join(__dirname, 'guardian.js')
      if (!existsSync(script)) {
        console.warn('[enforcement] guardian.js 未构建，L2 守护能力降级（跳过拉起）')
        return
      }
      // 独立 Node 进程（模拟系统服务行为；真实 Windows Service 注册见 guardian.ts --install-service）
      guardian = spawn(
        process.env.ELECTRON_RUN_AS_NODE ? process.execPath : 'node',
        [script, '--watch', pidFile, '--kill-taskmgr', '--interval', '2000'],
        { stdio: 'ignore', detached: true, windowsHide: true }
      )
      guardian.unref()
    } catch (err) {
      console.warn('[enforcement] 守护进程拉起失败:', err instanceof Error ? err.message : err)
    }
  }

  function stopGuardian(): void {
    if (guardian) {
      try {
        guardian.kill()
      } catch {
        // 忽略
      }
      guardian = null
    }
    try {
      unlinkSync(join(app.getPath('userData'), 'enforced.pid'))
    } catch {
      // 文件不存在忽略
    }
  }

  // ================= 重启恢复（防重启绕过） =================

  function restoreAfterRestart(): void {
    const enforced = getSettings().enforced
    if (!enforced?.active) return
    const win = getWindow()
    if (!win) return

    const elapsedMs = Date.now() - enforced.startedAt
    const remainingMs = enforced.plannedMs - elapsedMs

    if (remainingMs <= 0) {
      // 离线期间已到期：记为完成并解除
      recordStudyStats(todayLocal(), enforced.mode, enforced.plannedMs, 1)
      if (enforced.sessionId) {
        recordSessionEnd(enforced.sessionId, {
          durationActual: enforced.plannedMs,
          pomosCompleted: 1,
          interruptions: 0,
          status: 'done'
        })
      }
      setSettings({ enforced: null })
      new Notification({
        title: '🍅 强制会话已到期',
        body: '应用离线期间专注计时已自动完成。',
        silent: true
      }).show()
      return
    }

    // 恢复：施加级别 + 续时（单调时钟剩余量）。
    // 与 beginEnforcement 对齐：bili 模式跳过置顶（悬浮面板须浮于视频之上）、
    // 登记失焦拉回豁免，避免重启恢复后的强制配置与运行时不一致
    applyLevelWindow(win, { skipAlwaysOnTop: enforced.mode === 'bili' })
    if (LEVEL_CAPS[enforced.level].globalShortcuts) registerShortcutGuard()
    windowGuard.start(win, enforced.level, currentPolicy, { exemptFromPullBack: overlayExempt })
    if (LEVEL_CAPS[enforced.level].killTaskmgr) startTaskmgrKill()
    if (LEVEL_CAPS[enforced.level].guardian) spawnGuardian()

    timer.restore({ mode: 'countdown', durationMs: enforced.plannedMs, elapsedMs })
    active = {
      level: enforced.level,
      mode: enforced.mode,
      startedAt: enforced.startedAt,
      sessionId: enforced.sessionId
    }
    lastPomos = timer.getSnapshot().completedPomodoros
    new Notification({
      title: '🔒 已恢复强制会话',
      body: `剩余 ${Math.ceil(remainingMs / 60_000)} 分钟（级别 ${enforced.level}）。`,
      silent: true
    }).show()
  }

  // ================= IPC 注册 =================

  // ---- 计时通道（专注模式，会话开始/结束联动强制引擎） ----
  ipcMain.handle(IPC_CHANNELS.timer.start, (_event, options: TimerOptions) => {
    beginEnforcement('focus', options.durationMs)
    return timer.start(options)
  })

  ipcMain.handle(IPC_CHANNELS.timer.stop, () => {
    const before = timer.getSnapshot()
    const result = timer.stop()
    // 正序手动结束计数的一段，补记统计（逆序到点已由 complete 记录）
    if (result.completedPomodoros > before.completedPomodoros) {
      recordStudyStats(todayLocal(), 'focus', result.elapsedMs, 1)
    }
    endEnforcement('manual')
    return result
  })

  ipcMain.handle(IPC_CHANNELS.timer.pause, () => timer.pause())
  ipcMain.handle(IPC_CHANNELS.timer.resume, () => timer.resume())
  ipcMain.handle(IPC_CHANNELS.timer.getState, () => timer.getSnapshot())

  // ---- 强制通道 ----
  ipcMain.handle(IPC_CHANNELS.enforce.setAlwaysOnTop, (_event, on: boolean) => {
    getWindow()?.setAlwaysOnTop(on === true)
    return on === true
  })

  ipcMain.handle(
    IPC_CHANNELS.enforce.applyDistractionPolicy,
    (_event, policy: DistractionPolicy): DistractionPolicy => {
      currentPolicy = policy
      if (active) {
        const win = getWindow()
        if (win) windowGuard.start(win, active.level, policy, { exemptFromPullBack: overlayExempt })
      }
      return policy
    }
  )

  ipcMain.handle(IPC_CHANNELS.enforce.lock, (_event, mode: string): boolean => {
    beginEnforcement(typeof mode === 'string' ? mode : 'focus', timer.getSnapshot().durationMs)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.enforce.unlock, (): boolean => {
    endEnforcement('manual')
    return true
  })

  // ---- 紧急退出 ----
  ipcMain.handle(IPC_CHANNELS.emergency.exit, (_event, code: string): EmergencyExitResult => {
    const level = active?.level ?? getSettings().lockLevel
    const result = emergency.verifyRecoveryCode(code ?? '', level)
    if (result.ok) {
      endEnforcement('emergency')
    }
    return result
  })

  ipcMain.handle(IPC_CHANNELS.emergency.setCode, (_event, code: string): boolean => {
    emergency.setRecoveryCode(code ?? '')
    return true
  })
  // P-2：紧急退出弹窗期间暂停窗口守卫的失焦拉回（渲染层随弹窗开合调用）
  ipcMain.handle(IPC_CHANNELS.emergency.setPullBackPaused, (_event, paused: boolean): void => {
    windowGuard.setPaused(paused === true)
  })

  // ================= B 站强制会话句柄 =================

  function enterBiliSession(videoWin: BrowserWindow, opts: { plannedMs: number; topic: string }): void {
    const cap = Math.min(
      opts.plannedMs || 0,
      getSettings().sessionMaxHours * 3600_000
    )
    beginEnforcement('bili', cap, videoWin)
    timer.start({ mode: 'countup', durationMs: cap })
  }

  function exitBiliSession(reason: 'manual' | 'completed' | 'emergency'): void {
    endEnforcement(reason)
  }

  return {
    restoreAfterRestart,
    enterBiliSession,
    exitBiliSession,
    setOverlayExempt: (win) => {
      overlayExemptWindow = win
    },
    setPullBackPaused: (paused) => {
      windowGuard.setPaused(paused)
    }
  }
}
