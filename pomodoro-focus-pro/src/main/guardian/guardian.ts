/**
 * 守护进程（方案 2.5 L2 / 方案 3.3）。
 * 独立 Node 进程，由主进程拉起（out/main/guardian.js），模拟 Windows Service 行为：
 * - 每 2s：关闭任务管理器；检测主进程 PID 是否存活，被杀则自动拉起
 * - 真实 Windows Service 注册：以管理员执行 node guardian.js --install-service
 *   （sc create PomodoroGuardian；卸载 --uninstall-service）
 *
 * 注意：守护进程是普通进程，用户可用 PowerShell / wmic / Process Explorer / taskkill 同时结束它与主进程；
 * --install-service 仅 sc create，未限定运行账户与权限。属"自律辅助"，不是安全边界（见 README 威胁模型）。
 *
 * 用法：
 *   node guardian.js --watch <pidFile> [--kill-taskmgr] [--interval 2000]
 *   node guardian.js --install-service --watch <pidFile> --kill-taskmgr
 *   node guardian.js --uninstall-service
 */

import { spawn } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { createHmac } from 'crypto'

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

/**
 * H-04：读取并校验 PID 文件。
 * 主进程在写入 enforced.pid 时会附加 HMAC-SHA256 签名（密钥经环境变量
 * POMODORO_GUARDIAN_SECRET 传给守护进程），守护进程据此校验文件是否被伪造/篡改。
 * 返回 { pid, valid }：valid=false 表示无密钥、无签名或签名不匹配（视为不可信）。
 */
function readPidFile(pidFile: string): { pid: number; valid: boolean } {
  try {
    const lines = readFileSync(pidFile, 'utf-8').trim().split(/\r?\n/)
    const pid = Number(lines[0])
    if (!Number.isFinite(pid) || pid <= 0) return { pid: 0, valid: false }
    // 无密钥（非本应用拉起）或无签名 → 不可信
    if (!GUARDIAN_SECRET || lines.length < 2) return { pid, valid: false }
    const expected = createHmac('sha256', GUARDIAN_SECRET).update(String(pid)).digest('hex')
    return { pid, valid: lines[1] === expected }
  } catch {
    return { pid: 0, valid: false }
  }
}

function isAlive(pidFile: string): boolean {
  if (!existsSync(pidFile)) return true // 无 pid 文件视为未在强制会话（不拉起）
  const { pid, valid } = readPidFile(pidFile)
  if (!valid) {
    // 签名无效（被伪造 / 篡改 / 密钥不匹配）：不据此判定死活，也不触发拉起
    console.warn('[guardian] pid 文件签名无效，忽略（可能被伪造）')
    return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const args = parseArgs()
const pidFile = args.watch ?? ''
const intervalMs = Number(args.interval ?? 2000) || 2000
/** H-04：relaunch 目标改为显式 exe + 参数数组，不再接受任意命令行字符串 */
const relaunchExe = args['relaunch-exe'] ?? ''
let relaunchArgs: string[] = []
try {
  const parsed = JSON.parse(args['relaunch-args'] ?? '[]') as unknown
  if (Array.isArray(parsed)) relaunchArgs = parsed.map((x) => String(x))
} catch {
  relaunchArgs = []
}
/** --kill-taskmgr=false 可显式关闭；默认开启 */
const killTaskmgrEnabled = args['kill-taskmgr'] !== 'false'
/** 主进程经环境变量注入的签名密钥 */
const GUARDIAN_SECRET = process.env.POMODORO_GUARDIAN_SECRET ?? ''

/**
 * H-04：安全拉起。仅在 pid 文件签名有效（确属本应用的强制会话）且 relaunch-exe
 * 是真实存在的文件时执行；spawn 使用参数数组（不经 shell），杜绝命令注入/任意命令执行。
 */
function tryRelaunch(): void {
  const { valid } = readPidFile(pidFile)
  if (!valid) {
    console.warn('[guardian] 跳过拉起：pid 文件签名无效')
    return
  }
  if (!relaunchExe || !existsSync(relaunchExe)) {
    console.warn('[guardian] 无有效 relaunch-exe，跳过拉起')
    return
  }
  console.log('[guardian] 主进程已退出，执行拉起:', relaunchExe, relaunchArgs.join(' '))
  const child = spawn(relaunchExe, relaunchArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
}

function run(): void {
  console.log(
    `[guardian] 守护进程启动 pid=${process.pid} watch=${pidFile} interval=${intervalMs}ms`
  )
  setInterval(() => {
    if (killTaskmgrEnabled) killTaskmgr()
    if (pidFile && !isAlive(pidFile)) tryRelaunch()
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
