import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 轻量持久化日志管理器。
 *
 * 特性：
 * 1. 控制台 + 本地日志文件（app.log）双写；
 * 2. 自动存放在应用数据目录：userData/logs/app.log；
 * 3. 支持文件体积上限（默认 5MB）与自动滚动归档（保留最近备份 app.log.1）；
 * 4. 容错设计：日志写入异常自动静默回退，绝不阻断业务逻辑。
 */

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB

export function getLogDir(): string {
  if (process.env.POMODORO_LOG_DIR) return process.env.POMODORO_LOG_DIR
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    if (app && typeof app.getPath === 'function') {
      return join(app.getPath('userData'), 'logs')
    }
  } catch {
    /* 测试环境或 Node 脚本环境 */
  }
  return join(process.cwd(), '.logs')
}

export function getLogFilePath(): string {
  return join(getLogDir(), 'app.log')
}

function formatTimestamp(): string {
  const now = new Date()
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const yyyy = now.getFullYear()
  const mm = pad(now.getMonth() + 1)
  const dd = pad(now.getDate())
  const hh = pad(now.getHours())
  const min = pad(now.getMinutes())
  const ss = pad(now.getSeconds())
  const ms = pad(now.getMilliseconds(), 3)
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}.${ms}`
}

function rotateLogIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    const stats = statSync(filePath)
    if (stats.size >= MAX_LOG_SIZE_BYTES) {
      const backupPath = `${filePath}.1`
      renameSync(filePath, backupPath)
    }
  } catch {
    // 忽略滚动异常
  }
}

function writeToFile(level: string, tag: string, message: string, extra?: unknown): void {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    const filePath = getLogFilePath()
    rotateLogIfNeeded(filePath)

    const extraStr = extra !== undefined ? ` ${typeof extra === 'object' ? JSON.stringify(extra) : String(extra)}` : ''
    const line = `[${formatTimestamp()}] [${level.toUpperCase()}] [${tag}] ${message}${extraStr}\n`
    appendFileSync(filePath, line, 'utf8')
  } catch {
    // 写入失败降级，不阻断主流程
  }
}

export const logger = {
  info(tag: string, message: string, extra?: unknown): void {
    console.info(`[${tag}] ${message}`, extra !== undefined ? extra : '')
    writeToFile('INFO', tag, message, extra)
  },

  warn(tag: string, message: string, extra?: unknown): void {
    console.warn(`[${tag}] ${message}`, extra !== undefined ? extra : '')
    writeToFile('WARN', tag, message, extra)
  },

  error(tag: string, message: string, extra?: unknown): void {
    console.error(`[${tag}] ${message}`, extra !== undefined ? extra : '')
    writeToFile('ERROR', tag, message, extra)
  },

  debug(tag: string, message: string, extra?: unknown): void {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[${tag}] ${message}`, extra !== undefined ? extra : '')
    }
    writeToFile('DEBUG', tag, message, extra)
  }
}
