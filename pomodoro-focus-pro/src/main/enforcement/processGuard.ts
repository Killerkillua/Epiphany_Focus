import { isWindows, spawnQuiet } from './spawnQuiet'

/**
 * 进程级防护（方案 2.5 L2）：
 * - 每 2s 关闭任务管理器（taskkill taskmgr.exe）
 * 守护进程本体见 src/main/guardian/guardian.ts（独立 Node 进程，由 enforcement 拉起）。
 */

let taskmgrTimer: NodeJS.Timeout | null = null

export function startTaskmgrKill(): void {
  if (!isWindows() || taskmgrTimer) return
  taskmgrTimer = setInterval(() => {
    spawnQuiet('taskkill', ['/F', '/IM', 'taskmgr.exe'])
  }, 2000)
}

export function stopTaskmgrKill(): void {
  if (taskmgrTimer) {
    clearInterval(taskmgrTimer)
    taskmgrTimer = null
  }
}
