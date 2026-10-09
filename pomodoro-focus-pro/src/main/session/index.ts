import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc'
import { TimerService } from '../timer'
import { recordSessionEnd, recordSessionStart, recordStudyStats, todayLocal } from '../storage/db'
import { closeVideo, getVideoState } from '../navigation/biliWindow'
import { applyLevelWindow, releaseLevelWindow } from '../enforcement/lockScreen'
import { getSettings } from '../storage/settings'
import { recordTelemetry } from '../telemetry'
import { showAppNotification } from '../notify'
import { isVideoStudyMode } from '../../shared/study'
import type {
  SessionMode,
  SessionStartOptions,
  SessionState,
  TimerSnapshot
} from '../../shared/types'

/**
 * 学习会话计时服务（视频学习 / 英语学习模式）。
 * - 复用 TimerService 倒计时引擎，但为独立实例：与专注模式的强制引擎解耦，
 *   不施加锁屏 / 快捷键拦截 / 守护进程（视频学习、英语是半开放环境）
 * - 可选全屏遮罩（settings.sessionOverlay，默认开启）：计时开始后对主窗口施加
 *   与专注模式一致的窗口级遮罩（全屏 + 置顶 + 禁缩放 + 隐藏任务栏 + 拦截关闭）
 * - 视频学习打开视频窗口时由导航模块挂起主窗口遮罩（视频窗口自身全屏锁定接管），关闭后恢复
 * - 到点：提示音（渲染层）+ 桌面通知 + 学习统计落库；视频学习模式自动关闭视频窗口（到点休息）
 * - 会话状态不持久化：学习会话非强制，重启后不恢复（与强制会话语义区分）
 */

const MIN_SESSION_MS = 1000
const MAX_SESSION_MS = 8 * 3600_000

/** 学习会话模块句柄（供 视频学习导航模块联动主窗口遮罩） */
export interface SessionHandle {
  /** 学习视频窗口打开：挂起主窗口遮罩，避免 screen-saver 置顶遮罩盖住全屏视频 */
  suspendOverlay: () => void
  /** 学习视频窗口关闭：恢复主窗口遮罩（会话仍在进行且设置开启时） */
  resumeOverlay: () => void
}

/** 向所有窗口广播（主窗口 + 悬浮面板 overlay，供计时进度环等使用） */
function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

export function registerSessionModule(getWindow: () => BrowserWindow | null): SessionHandle {
  const sessionTimer = new TimerService(
    (snap) => {
      broadcastToAllWindows(IPC_EVENTS.session.tick, snap)
    },
    (snap) => {
      broadcastToAllWindows(IPC_EVENTS.session.complete, snap)
      onSessionComplete(snap)
    }
  )

  let sessionId: number | null = null
  let currentMode: SessionMode = 'english'
  /** 主窗口学习会话遮罩是否已施加（settings.sessionOverlay 开启时） */
  let overlayApplied = false
  /** 学习视频窗口打开期间是否挂起了主窗口遮罩 */
  let overlaySuspended = false

  /** 施加主窗口全屏遮罩（与专注模式 applyLevelWindow 同源，按窗口引用计数） */
  function applySessionOverlay(): void {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    applyLevelWindow(win)
    overlayApplied = true
  }

  /** 解除主窗口全屏遮罩（引用计数归零才真正还原窗口属性） */
  function releaseSessionOverlay(): void {
    if (!overlayApplied) return
    const win = getWindow()
    if (win && !win.isDestroyed()) releaseLevelWindow(win)
    overlayApplied = false
  }

  function onSessionComplete(snap: TimerSnapshot): void {
    // 分钟换算统一在 recordStudyStats 内完成（毫秒入参）；此处仅用于通知文案
    const minutes = Math.max(1, Math.round(snap.elapsedMs / 60_000))
    recordTelemetry('session', 'complete', { mode: currentMode, minutes })
    recordStudyStats(todayLocal(), currentMode, snap.elapsedMs, 1)
    if (sessionId) {
      recordSessionEnd(sessionId, {
        durationActual: snap.elapsedMs,
        pomosCompleted: 1,
        interruptions: 0,
        status: 'done'
      })
      sessionId = null
    }

    // 视频学习模式到点：自动关闭学习内容窗口（到点休息）
    if (isVideoStudyMode(currentMode)) {
      try {
        closeVideo()
      } catch {
        // 视频窗口关闭失败不阻塞完成流程
      }
    }

    showAppNotification(
      isVideoStudyMode(currentMode) ? '视频学习时间到' : '英语学习时间到',
      `本轮学习 ${minutes} 分钟，休息一下吧！`
    )

    // 到点完成：解除主窗口学习会话遮罩
    releaseSessionOverlay()
  }

  ipcMain.handle(IPC_CHANNELS.session.start, (_event, opts: SessionStartOptions): SessionState => {
    const durationMs = Math.max(
      MIN_SESSION_MS,
      Math.min(MAX_SESSION_MS, Number.isFinite(opts?.durationMs) ? opts.durationMs : 60 * 60_000)
    )
    currentMode = opts?.mode === 'study' ? 'study' : opts?.mode === 'bili' ? 'bili' : 'english'
    recordTelemetry('session', 'start', {
      mode: currentMode,
      durationMinutes: Math.round(durationMs / 60_000)
    })
    sessionId =
      recordSessionStart({
        mode: currentMode,
        level: 'L0',
        startedAt: Date.now(),
        durationPlanned: durationMs
      }) ?? null
    sessionTimer.start({ mode: 'countdown', durationMs })
    // 学习会话全屏遮罩（可配置，默认开启）：视频窗口打开 / 挂起期间不施加（由视频窗口全屏锁定接管）
    if (
      getSettings().sessionOverlay &&
      !overlayApplied &&
      !overlaySuspended &&
      !getVideoState().open
    ) {
      applySessionOverlay()
    }
    return { mode: currentMode, timer: sessionTimer.getSnapshot() }
  })

  ipcMain.handle(IPC_CHANNELS.session.stop, (): SessionState => {
    const before = sessionTimer.getSnapshot()
    const result = sessionTimer.stop()
    // 手动结束：已学习 ≥1 分钟计入统计
    if (before.status === 'running' || before.status === 'paused') {
      // 已学习时长是否计入统计由 recordStudyStats 统一判定（≥1 分钟才记录）
      recordStudyStats(todayLocal(), currentMode, result.elapsedMs, 1)
      if (sessionId) {
        recordSessionEnd(sessionId, {
          durationActual: result.elapsedMs,
          pomosCompleted: result.elapsedMs >= 60_000 ? 1 : 0,
          interruptions: 0,
          status: result.elapsedMs >= 60_000 ? 'done' : 'abandoned'
        })
        sessionId = null
      }
    }
    // 手动结束：解除主窗口学习会话遮罩
    releaseSessionOverlay()
    return { mode: currentMode, timer: result }
  })

  ipcMain.handle(IPC_CHANNELS.session.pause, (): SessionState => ({
    mode: currentMode,
    timer: sessionTimer.pause()
  }))
  ipcMain.handle(IPC_CHANNELS.session.resume, (): SessionState => ({
    mode: currentMode,
    timer: sessionTimer.resume()
  }))
  ipcMain.handle(IPC_CHANNELS.session.getState, (): SessionState => ({
    mode: currentMode,
    timer: sessionTimer.getSnapshot()
  }))

  // ================= 遮罩联动句柄（学习视频窗口开/关） =================

  return {
    suspendOverlay: (): void => {
      overlaySuspended = true
      releaseSessionOverlay()
    },
    resumeOverlay: (): void => {
      overlaySuspended = false
      if (!getSettings().sessionOverlay || overlayApplied) return
      const st = sessionTimer.getSnapshot().status
      if (st === 'running' || st === 'paused') {
        applySessionOverlay()
      }
    }
  }
}
