import { spawn } from 'child_process'

/**
 * 进程级防护（方案 2.5 L2）：
 * - 每 2s 关闭任务管理器（taskkill taskmgr.exe）
 * 守护进程本体见 src/main/guardian/guardian.ts（独立 Node 进程，由 enforcement 拉起）。
 */

let taskmgrTimer: NodeJS.Timeout | null = null

export function startTaskmgrKill(): void {
  if (taskmgrTimer) return
  taskmgrTimer = setInterval(() => {
    spawn('taskkill', ['/F', '/IM', 'taskmgr.exe'], { stdio: 'ignore', windowsHide: true }).unref()
  }, 2000)
}

export function stopTaskmgrKill(): void {
  if (taskmgrTimer) {
    clearInterval(taskmgrTimer)
    taskmgrTimer = null
  }
}
