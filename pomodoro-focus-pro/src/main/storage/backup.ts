import { app } from 'electron'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { BACKUP_VERSION, type BackupFile, type BackupMeta } from '../../shared/backup'
import { exportBackupData, recordBackupMeta } from './db'
import { getSettings } from './settings'

/**
 * 数据备份服务（M5：本地 JSON 备份 + 自动备份调度）。
 * - 手动备份 / 导入走 IPC（navigation/index.ts 弹文件对话框后调用本模块）
 * - 自动备份：setTimeout 轮询（每分钟），到设定时刻（或启动时已过点）且当天未备份则执行；
 *   保留最近 N 份（keepCount），备份失败只记日志不影响主流程
 * - 无需 node-cron 依赖（spec 允许 setTimeout 轮询）
 */

/** 默认备份目录：文档/番茄专注备份 */
export function defaultBackupDir(): string {
  return join(app.getPath('documents'), '番茄专注备份')
}

/** 组装备份文件（当前数据快照 + 学习目标） */
export function buildBackupFile(): BackupFile {
  const goals = getSettings().studyGoals ?? { dailyMinutes: 0, weeklyDays: 0 }
  return {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    data: {
      ...exportBackupData(),
      settings: {
        dailyMinutes: Number(goals.dailyMinutes) || 0,
        weeklyDays: Number(goals.weeklyDays) || 0
      }
    }
  }
}

/** 解析并校验备份文件（version + 必填字段），非法抛错 */
export function parseBackupFile(text: string): BackupFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('备份文件不是有效的 JSON')
  }
  const file = json as BackupFile
  if (
    !file ||
    typeof file !== 'object' ||
    file.version !== BACKUP_VERSION ||
    !file.data ||
    !Array.isArray(file.data.playRecords) ||
    !Array.isArray(file.data.notes) ||
    !Array.isArray(file.data.studySessions)
  ) {
    throw new Error('备份文件格式不正确或版本不受支持（需要 version ' + BACKUP_VERSION + '）')
  }
  return file
}

/** 写入备份文件（含元数据落库），返回元数据 */
export function writeBackupFile(
  filePath: string,
  backup: BackupFile,
  backupType: 'manual' | 'auto' = 'manual'
): BackupMeta {
  writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8')
  const meta = {
    filePath,
    fileSize: statSync(filePath).size,
    recordCount: backup.data.playRecords.length,
    backupType,
    createdAt: Date.now()
  }
  recordBackupMeta(meta)
  return { id: 0, ...meta }
}

/** 清理目录中超出保留份数的备份文件（文件名含时间戳，字典序 = 时间序；保留最新的 N 份） */
export function pruneBackups(dir: string, keepCount: number): number {
  if (keepCount <= 0 || !existsSync(dir)) return 0
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('pomodoro-backup-') && f.endsWith('.json'))
    .sort()
  const excess = files.length - keepCount
  for (let i = 0; i < excess; i++) {
    try {
      rmSync(join(dir, files[i]), { force: true })
    } catch {
      /* 单个清理失败不中断 */
    }
  }
  return Math.max(0, excess)
}

/** 本地日期 YYYY-MM-DD（与 db.ts todayLocal 一致，避免导出函数依赖） */
function localDateStr(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

let scheduler: NodeJS.Timeout | null = null

/**
 * 执行一次自动备份（幂等：当天已备份则跳过）。返回是否执行。
 * 频率：daily = 每天到点；weekly = 每周日到点（frequency 取 weekly 时）。
 */
export function runAutoBackupOnce(now = new Date()): boolean {
  const cfg = getSettings().backup
  if (!cfg?.enabled) return false
  const [h, m] = (cfg.time ?? '03:00').split(':').map((x) => Number(x) || 0)
  // 已过目标时刻才可能执行；weekly 仅在周日执行
  const passed = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)
  if (!passed) return false
  if (cfg.frequency === 'weekly' && now.getDay() !== 0) return false

  const dir = cfg.directory?.trim() || defaultBackupDir()
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      console.warn('[backup] 创建备份目录失败:', err instanceof Error ? err.message : err)
      return false
    }
  }
  // 当天已备份过则跳过（补备只在"当天首次到达时刻"发生一次）
  const today = localDateStr(now)
  try {
    const done = readdirSync(dir).some(
      (f) => f.startsWith(`pomodoro-backup-${today}`) && f.endsWith('.json')
    )
    if (done) return false
    const stamp = `${today}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    writeBackupFile(join(dir, `pomodoro-backup-${stamp}.json`), buildBackupFile(), 'auto')
    pruneBackups(dir, cfg.keepCount ?? 7)
    console.info(`[backup] 自动备份完成：${today}`)
    return true
  } catch (err) {
    // 备份失败仅记录日志，不影响应用主流程（spec：备份失败不影响主流程）
    console.warn('[backup] 自动备份失败:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * 启动自动备份调度（幂等）：每分钟检查一次。
 * 应用启动时若已过设定时刻且当天未备份，则立即补备。
 */
export function startAutoBackup(): void {
  if (scheduler) return
  const tick = (): void => {
    try {
      runAutoBackupOnce()
    } catch (err) {
      console.warn('[backup] 自动备份调度异常:', err instanceof Error ? err.message : err)
    }
  }
  tick()
  scheduler = setInterval(tick, 60_000)
}

/** 读取备份文件（手动导入用） */
export function readBackupFile(filePath: string): BackupFile {
  return parseBackupFile(readFileSync(filePath, 'utf-8'))
}
