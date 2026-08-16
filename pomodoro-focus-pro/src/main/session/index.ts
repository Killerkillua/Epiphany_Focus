import { BrowserWindow, Notification, ipcMain } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '../ipc'
import { TimerService } from '../timer'
import {
  recordSessionEnd,
  recordSessionStart,
  recordStudyStats,
  todayLocal
} from '../storage/db'
import { closeVideo } from '../navigation/biliWindow'
import type { SessionMode, SessionStartOptions, SessionState, TimerSnapshot } from '../../shared/types'

/**
 * 学习会话计时服务（B 站学习 / 英语学习模式）。
 * - 复用 TimerService 倒计时引擎，但为独立实例：与专注模式的强制引擎解耦，
 *   不施加锁屏 / 遮罩 / 快捷键拦截（B 站、英语是半开放环境）
 * - 到点：提示音（渲染层）+ 桌面通知 + 学习统计落库；B 站模式自动关闭视频窗口（到点休息）
 * - 会话状态不持久化：学习会话非强制，重启后不恢复（与强制会话语义区分）
 */

const MIN_SESSION_MS = 1000
const MAX_SESSION_MS = 8 * 3600_000

export function registerSessionModule(getWindow: () => BrowserWindow | null): void {
  const sessionTimer = new TimerService(
    (snap) => {
      getWindow()?.webContents.send(IPC_EVENTS.session.tick, snap)
    },
    (snap) => {
      getWindow()?.webContents.send(IPC_EVENTS.session.complete, snap)
      onSessionComplete(snap)
    }
  )

  let sessionId: number | null = null
  let currentMode: SessionMode = 'english'

  function onSessionComplete(snap: TimerSnapshot): void {
    const minutes = Math.max(1, Math.ceil(snap.elapsedMs / 60_000))
    recordStudyStats(todayLocal(), currentMode, minutes, 1)
    if (sessionId) {
      recordSessionEnd(sessionId, {
        durationActual: snap.elapsedMs,
        pomosCompleted: 1,
        interruptions: 0,
        status: 'done'
      })
      sessionId = null
    }

    // B 站模式到点：自动关闭视频窗口（到点休息，方案 2.2）
    if (currentMode === 'bili') {
      try {
        closeVideo()
      } catch {
        // 视频窗口关闭失败不阻塞完成流程
      }
    }

    new Notification({
      title: currentMode === 'bili' ? '📺 B 站学习时间到' : '📖 英语学习时间到',
      body: `本轮学习 ${minutes} 分钟，休息一下吧！`,
      silent: true
    }).show()
  }

  ipcMain.handle(IPC_CHANNELS.session.start, (_event, opts: SessionStartOptions): SessionState => {
    const durationMs = Math.max(
      MIN_SESSION_MS,
      Math.min(MAX_SESSION_MS, Number.isFinite(opts?.durationMs) ? opts.durationMs : 60 * 60_000)
    )
    currentMode = opts?.mode === 'bili' ? 'bili' : 'english'
    sessionId =
      recordSessionStart({
        mode: currentMode,
        level: 'L0',
        startedAt: Date.now(),
        durationPlanned: durationMs
      }) ?? null
    sessionTimer.start({ mode: 'countdown', durationMs })
    return { mode: currentMode, timer: sessionTimer.getSnapshot() }
  })

  ipcMain.handle(IPC_CHANNELS.session.stop, (): SessionState => {
    const before = sessionTimer.getSnapshot()
    const result = sessionTimer.stop()
    // 手动结束：已学习 ≥1 分钟计入统计
    if (before.status === 'running' || before.status === 'paused') {
      const minutes = Math.ceil(result.elapsedMs / 60_000)
      if (result.elapsedMs >= 60_000) {
        recordStudyStats(todayLocal(), currentMode, minutes, 1)
      }
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
}
