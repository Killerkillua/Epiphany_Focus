/**
 * 守护进程（方案 2.5 L2 / 方案 3.3）。
 * 独立 Node 进程，由主进程拉起（out/main/guardian.js），模拟 Windows Service 行为：
 * - 每 2s：关闭任务管理器；检测主进程 PID 是否存活，被杀则自动拉起
 * - 真实 Windows Service 注册：以管理员执行 node guardian.js --install-service
 *   （sc create PomodoroGuardian；卸载 --uninstall-service）
 *
 * 用法：
 *   node guardian.js --watch <pidFile> [--kill-taskmgr] [--interval 2000]
 *   node guardian.js --install-service --watch <pidFile> --kill-taskmgr
 *   node guardian.js --uninstall-service
 */

import { spawn } from 'child_process'
import { readFileSync, existsSync } from 'fs'

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const next = argv[i + 1]
    // 仅当下一个参数不是 flag 时才作为值消费（无值 flag 记 'true'）
    args[key.slice(2)] = next !== undefined && !next.startsWith('--') ? next : 'true'
  }
  return args
}

function killTaskmgr(): void {
  spawn('taskkill', ['/F', '/IM', 'taskmgr.exe'], { stdio: 'ignore', windowsHide: true }).unref()
}

function isAlive(pidFile: string): boolean {
  try {
    if (!existsSync(pidFile)) return true // 无 pid 文件视为未在强制会话（不拉起）
    const pid = Number(readFileSync(pidFile, 'utf-8').trim())
    if (!Number.isFinite(pid) || pid <= 0) return true
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const args = parseArgs()
const pidFile = args.watch ?? ''
const intervalMs = Number(args.interval ?? 2000) || 2000
const relaunchCmd = args.relaunchCmd
/** --kill-taskmgr=false 可显式关闭；默认开启 */
const killTaskmgrEnabled = args['kill-taskmgr'] !== 'false'

function run(): void {
  console.log(`[guardian] 守护进程启动 pid=${process.pid} watch=${pidFile} interval=${intervalMs}ms`)
  setInterval(() => {
    if (killTaskmgrEnabled) killTaskmgr()
    if (pidFile && !isAlive(pidFile) && relaunchCmd) {
      console.log('[guardian] 主进程已退出，执行拉起:', relaunchCmd)
      const child = spawn(relaunchCmd, { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    }
  }, intervalMs)
}

function installService(): void {
  const nodeExe = process.execPath
  const script = process.argv[1]
  const binPath = `"${nodeExe}" "${script}" --watch "${pidFile}" --kill-taskmgr --interval ${intervalMs}`
  spawn('sc.exe', ['create', 'PomodoroGuardian', `binPath= ${binPath}`, 'start= auto'], {
    stdio: 'inherit',
    windowsHide: true
  })
}

function uninstallService(): void {
  spawn('sc.exe', ['delete', 'PomodoroGuardian'], { stdio: 'inherit', windowsHide: true })
}

if (args['install-service']) {
  installService()
} else if (args['uninstall-service']) {
  uninstallService()
} else {
  run()
}
