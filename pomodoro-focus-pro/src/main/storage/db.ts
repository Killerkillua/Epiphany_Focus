import { app } from 'electron'
import { createRequire } from 'module'
import { join } from 'path'
import type { GrammarPoint, VocabEntry } from '../../shared/ai'
import type { NoteEntry, NoteSource } from '../../shared/bili'
import type { BackupFileData, BackupMeta, ImportResult } from '../../shared/backup'
import type {
  DailyStat,
  DayTrendPoint,
  FeedbackCategory,
  FeedbackEntry,
  FeedbackStats,
  HeatmapCell,
  HomeSummary,
  ModeStat,
  PlayRecord,
  PlayRecordTick,
  PlayRecordUpdate,
  PlayStatus,
  ProgressFilter,
  ProgressStats,
  SessionSource,
  StudySession
} from '../../shared/stats'
import { getSettings } from './settings'

/**
 * 中央 SQLite 存储（方案 3.4，表名/字段名与规约一致）：
 *   sessions(id, mode, level, started_at, duration_planned, duration_actual,
 *            pomos_completed, interruptions, status, ended_at)
 *   study_stats(date, mode, minutes, pomos)
 *   notes(id, created_at, video_title, content, tags, bvid, timestamp_s, is_key, source, parent_id)
 *   play_records(bvid, title, duration_s, watched_s, last_position_s, status,
 *                viewed_count, goal_rounds, goal_deadline, cover_url, author, created_at, updated_at)
 *   play_record_tags(id, bvid, tag, created_at)              —— M1 标签关联（UNIQUE(bvid, tag)）
 *   study_sessions(id, bvid, start_at, end_at, duration_s, source, created_at)  —— M3 会话明细
 *   backup_meta(id, file_path, file_size, record_count, backup_type, created_at) —— M5 备份元数据
 *   feedback(id, mode, rating, category, detail, created_at)
 *   events(id, domain, action, payload_json, created_at)   —— 匿名遥测（R-2）
 *   vocab(id, word, phonetic, definition, example, added_at)
 *   grammar_points(id, title, summary, added_at)
 *   ai_conversations(id, mode, messages_json, created_at)
 */

export interface SqliteLike {
  pragma(sql: string): unknown
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint }
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  close?(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'L0',
  started_at INTEGER NOT NULL,
  duration_planned INTEGER NOT NULL DEFAULT 0,
  duration_actual INTEGER NOT NULL DEFAULT 0,
  pomos_completed INTEGER NOT NULL DEFAULT 0,
  interruptions INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS study_stats (
  date TEXT NOT NULL,
  mode TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  pomos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, mode)
);
-- notes：id 为 TEXT 主键（渲染层生成稳定 key，增量 upsert 的前提，F-1/P-1）。
-- 旧版本为 INTEGER AUTOINCREMENT 主键，启动迁移会重建为 TEXT 主键（见 migrateNotesTable）。
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  video_title TEXT DEFAULT '',
  content TEXT NOT NULL,
  tags TEXT DEFAULT '',
  bvid TEXT DEFAULT '',
  timestamp_s INTEGER DEFAULT 0,
  is_key INTEGER DEFAULT 0,
  source TEXT DEFAULT 'main',
  parent_id TEXT DEFAULT ''
);
-- 按视频学习进度（F-3）：bvid 主键，会话级撮合，非逐帧跟踪。
-- M1/M2 扩展：cover_url / author（记录卡片封面与 UP 主快照）
CREATE TABLE IF NOT EXISTS play_records (
  bvid TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  duration_s INTEGER DEFAULT 0,
  watched_s INTEGER DEFAULT 0,
  last_position_s INTEGER DEFAULT 0,
  status TEXT DEFAULT 'planned',
  viewed_count INTEGER DEFAULT 0,
  goal_rounds INTEGER DEFAULT 0,
  goal_deadline TEXT DEFAULT '',
  cover_url TEXT DEFAULT '',
  author TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- M1 标签关联表：一视频多标签，去重（UNIQUE(bvid, tag)）
CREATE TABLE IF NOT EXISTS play_record_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bvid TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(bvid, tag)
);
CREATE INDEX IF NOT EXISTS idx_prt_tag ON play_record_tags(tag);
-- M3 学习会话明细：一次打开视频 → 关闭视频 为一个会话（wall-clock 时长）
CREATE TABLE IF NOT EXISTS study_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bvid TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL DEFAULT 0,
  duration_s INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_sessions_bvid ON study_sessions(bvid);
CREATE INDEX IF NOT EXISTS idx_study_sessions_start_at ON study_sessions(start_at);
-- M5 备份元数据（手动 / 自动备份的文件信息，供设置页查看）
CREATE TABLE IF NOT EXISTS backup_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  backup_type TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
-- 用户反馈（R-1）：满意度打分 + 分类 + 一句话描述，本地落库
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  rating INTEGER NOT NULL,
  category TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
-- 匿名事件表（R-2，opt-in）：domain:action + JSON payload，仅计数/时长，无内容文本
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vocab (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  phonetic TEXT DEFAULT '',
  definition TEXT DEFAULT '',
  example TEXT DEFAULT '',
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grammar_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dict_entries (
  word TEXT PRIMARY KEY,
  phonetic TEXT DEFAULT '',
  definition_cn TEXT NOT NULL,
  definition_en TEXT DEFAULT '',
  pos TEXT DEFAULT '',
  collins INTEGER DEFAULT 0,
  oxford INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dict_entries_word ON dict_entries(word);
`

/** notes 新表结构（TEXT 主键 + 分视频/重点字段） */
const NOTES_TABLE_DDL = `
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  video_title TEXT DEFAULT '',
  content TEXT NOT NULL,
  tags TEXT DEFAULT '',
  bvid TEXT DEFAULT '',
  timestamp_s INTEGER DEFAULT 0,
  is_key INTEGER DEFAULT 0,
  source TEXT DEFAULT 'main',
  parent_id TEXT DEFAULT ''
)`

/**
 * notes 表迁移（F-1/P-1，数据零丢失）：
 * - 旧表 id 为 INTEGER AUTOINCREMENT：升级为 TEXT 主键（增量 upsert 需要稳定文本 key），
 *   旧行 id 经 CAST 转文本保留；新增 bvid / timestamp_s / is_key / source / parent_id 列。
 * - 新库直接走 SCHEMA 的 TEXT 主键建表，无需迁移。
 */
/**
 * 迁移实现（测试可见）：旧 INTEGER 主键 notes → TEXT 主键 + 新字段。
 * 迁移必须原子：RENAME → CREATE → INSERT → DROP 四步包裹在事务中，
 * 任一步骤失败即整体 ROLLBACK，保留原 notes 表与数据，避免留下
 * "旧表已改名但新表为空/不全" 的半迁移状态（用户笔记原地丢失）。
 */
export function migrateNotesTable(d: SqliteLike): void {
  const cols = d.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>
  const names = new Set(cols.map((c) => c.name))
  if (names.has('bvid') && names.has('timestamp_s') && names.has('is_key') && names.has('source'))
    return
  try {
    d.prepare('BEGIN').run()
    try {
      d.exec(`
        ALTER TABLE notes RENAME TO notes_legacy;
        ${NOTES_TABLE_DDL};
        INSERT INTO notes (id, created_at, video_title, content, tags, bvid, timestamp_s, is_key, source, parent_id)
          SELECT CAST(id AS TEXT), created_at, video_title, content, tags, '', 0, 0, 'main', '' FROM notes_legacy;
        DROP TABLE notes_legacy;
      `)
      d.prepare('COMMIT').run()
    } catch (inner) {
      // 失败回滚：notes_legacy 改名与新建表全部撤销，原 notes 表与数据完整保留
      try {
        d.prepare('ROLLBACK').run()
      } catch {
        // 回滚失败（连接级异常）时原样抛出内层错误
      }
      throw inner
    }
    console.info('[storage] notes 表已迁移：TEXT 主键 + bvid/timestamp_s/is_key/source 字段')
  } catch (err) {
    console.warn(
      '[storage] notes 表迁移失败，沿用旧结构:',
      err instanceof Error ? err.message : err
    )
  }
}

/**
 * play_records 增量迁移（M1/M2）：老库补 cover_url / author 列。
 * 幂等：PRAGMA table_info 检查已存在即跳过；事务包裹，失败回滚不留半迁移态。
 */
export function migratePlayRecordsColumns(d: SqliteLike): void {
  const cols = d.prepare('PRAGMA table_info(play_records)').all() as Array<{ name: string }>
  const names = new Set(cols.map((c) => c.name))
  if (names.has('cover_url') && names.has('author')) return
  try {
    d.prepare('BEGIN').run()
    try {
      if (!names.has('cover_url'))
        d.exec(`ALTER TABLE play_records ADD COLUMN cover_url TEXT DEFAULT ''`)
      if (!names.has('author')) d.exec(`ALTER TABLE play_records ADD COLUMN author TEXT DEFAULT ''`)
      d.prepare('COMMIT').run()
    } catch (inner) {
      try {
        d.prepare('ROLLBACK').run()
      } catch {
        // 忽略回滚失败
      }
      throw inner
    }
    console.info('[storage] play_records 已迁移：cover_url / author 列')
  } catch (err) {
    console.warn(
      '[storage] play_records 迁移失败，沿用旧结构:',
      err instanceof Error ? err.message : err
    )
  }
}

let db: SqliteLike | null = null
let warned = false

/** 默认（旧版/首个注册账号接管）数据库文件名 */
export const LEGACY_DB_FILE = 'pomodoro.db'

/** 当前账号对应的数据库文件名（相对 userData）；账号模块登录/登出时切换 */
let activeDbFile: string = LEGACY_DB_FILE

/**
 * 切换当前账号的数据库文件：关闭旧连接，下次 getDb() 打开新文件。
 * 每个账号独立一个 SQLite 文件，所有业务查询天然按账号隔离。
 */
export function setActiveDbFile(file: string): void {
  if (file === activeDbFile) return
  closeDb()
  activeDbFile = file
}

export function getActiveDbFile(): string {
  return activeDbFile
}

/**
 * 打开一个 SQLite 文件并设置 WAL（不建业务表）。
 * 测试驱动：POMODORO_DB_DRIVER=node:sqlite 时使用系统 Node 内置 SQLite
 * （better-sqlite3 按 Electron ABI 编译，纯 Node 的 vitest 无法加载原生绑定）。
 */
export function openSqlite(dbPath: string): SqliteLike {
  if (process.env.POMODORO_DB_DRIVER === 'node:sqlite') {
    const { DatabaseSync } = createRequire(__filename)(
      'node:sqlite'
    ) as typeof import('node:sqlite')
    const sync = new DatabaseSync(dbPath)
    sync.exec('PRAGMA journal_mode = WAL')
    return sync as unknown as SqliteLike
  }
  // better-sqlite3 为原生模块，动态 require 以便加载失败时优雅降级
  const require = createRequire(__filename)
  const Database = require('better-sqlite3') as new (file: string) => SqliteLike
  const d = new Database(dbPath)
  d.pragma('journal_mode = WAL')
  return d
}

export function getDb(): SqliteLike | null {
  if (db) return db
  try {
    // 测试注入：POMODORO_DB_PATH 指向隔离的临时数据库（生产环境不设置，走 userData）
    const dbPath = process.env.POMODORO_DB_PATH || join(app.getPath('userData'), activeDbFile)
    const opened = openSqlite(dbPath)
    opened.exec(SCHEMA)
    migrateNotesTable(opened)
    migratePlayRecordsColumns(opened)
    db = opened
    return db
  } catch (err) {
    if (!warned) {
      warned = true
      console.warn(
        '[storage] SQLite 不可用，统计/生词本等功能不可用:',
        err instanceof Error ? err.message : err
      )
    }
    return null
  }
}

/** 关闭并释放数据库连接（账号切换/测试隔离用） */
export function closeDb(): void {
  if (db) {
    try {
      db.close?.()
    } catch {
      // 忽略关闭错误
    }
    db = null
  }
}
/** 本地日期 YYYY-MM-DD */
export function todayLocal(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// ================= sessions =================

export function recordSessionStart(opts: {
  mode: string
  level: string
  startedAt: number
  durationPlanned: number
}): number | null {
  const d = getDb()
  if (!d) return null
  const info = d
    .prepare(
      `INSERT INTO sessions (mode, level, started_at, duration_planned, status)
       VALUES (?, ?, ?, ?, 'active')`
    )
    .run(opts.mode, opts.level, opts.startedAt, opts.durationPlanned)
  return Number(info.lastInsertRowid ?? 0) || null
}

export function recordSessionEnd(
  sessionId: number,
  opts: { durationActual: number; pomosCompleted: number; interruptions: number; status: string }
): void {
  const d = getDb()
  if (!d || !sessionId) return
  d.prepare(
    `UPDATE sessions SET duration_actual = ?, pomos_completed = ?, interruptions = ?, status = ?, ended_at = ? WHERE id = ?`
  ).run(
    opts.durationActual,
    opts.pomosCompleted,
    opts.interruptions,
    opts.status,
    Date.now(),
    sessionId
  )
}

// ================= study_stats =================

/** 不足 1 分钟的时长不记录（与"已学习 ≥1 分钟计入统计"的语义一致） */
const MIN_RECORD_MS = 60_000

/**
 * 记录学习统计（study_stats UPSERT 累加）。
 * 时间口径统一：调用方只传原始毫秒，分钟换算与取整只在此处发生一次，
 * 避免多路径 Math.ceil / Math.round 不一致造成 ±1 分钟偏差。
 */
export function recordStudyStats(
  date: string,
  mode: string,
  elapsedMs: number,
  pomos: number
): void {
  const d = getDb()
  if (!d || !Number.isFinite(elapsedMs) || elapsedMs < MIN_RECORD_MS) return
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000))
  d.prepare(
    `INSERT INTO study_stats (date, mode, minutes, pomos) VALUES (?, ?, ?, ?)
     ON CONFLICT(date, mode) DO UPDATE SET
       minutes = minutes + excluded.minutes,
       pomos = pomos + excluded.pomos`
  ).run(date, mode, minutes, Math.max(0, pomos))
}

export function getDayTrend(days: number): DayTrendPoint[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT date, SUM(minutes) AS minutes, SUM(pomos) AS pomos
       FROM study_stats
       WHERE date >= date('now', ?, 'localtime')
       GROUP BY date ORDER BY date`
    )
    .all(`-${Math.max(1, days)} days`) as Array<{ date: string; minutes: number; pomos: number }>
  return rows.map((r) => ({ date: r.date, minutes: Number(r.minutes), pomos: Number(r.pomos) }))
}

export function getModeCompare(): ModeStat[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT mode, SUM(minutes) AS minutes, SUM(pomos) AS pomos FROM study_stats GROUP BY mode ORDER BY minutes DESC`
    )
    .all() as Array<{ mode: string; minutes: number; pomos: number }>
  return rows.map((r) => ({ mode: r.mode, minutes: Number(r.minutes), pomos: Number(r.pomos) }))
}

export function getHourHeatmap(): HeatmapCell[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT
         CAST(strftime('%w', datetime(started_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS weekday,
         CAST(strftime('%H', datetime(started_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
         CAST(SUM(duration_actual) AS REAL) / 60000.0 AS minutes,
         COUNT(*) AS sessions
       FROM sessions
       WHERE status = 'done' AND ended_at IS NOT NULL
       GROUP BY weekday, hour`
    )
    .all() as Array<{ weekday: number; hour: number; minutes: number; sessions: number }>
  return rows.map((r) => ({
    weekday: Number(r.weekday),
    hour: Number(r.hour),
    // 保留 1 位小数（修复 SQLite 整数除法截断：90s → 1.5 分钟而非 1）
    minutes: Math.round(Number(r.minutes) * 10) / 10,
    sessions: Number(r.sessions)
  }))
}

export function getHomeSummary(): HomeSummary {
  const d = getDb()
  if (!d) return { todayMinutes: 0, todayPomos: 0, streakDays: 0 }
  const today = todayLocal()

  const todayRow = d
    .prepare(
      `SELECT COALESCE(SUM(minutes),0) AS minutes,
            COALESCE(SUM(pomos),0) AS pomos
     FROM study_stats WHERE date = ?`
    )
    .get(today) as { minutes: number; pomos: number }

  // 连续天数回溯全部有学习记录的日期（study_stats 按天聚合，每天最多 1 行，
  // 全量加载开销可忽略；窗口化会把超过窗口的连续记录截断，导致 streak 偏小）
  const rows = d
    .prepare(
      `SELECT date FROM study_stats
     GROUP BY date HAVING SUM(minutes) > 0
     ORDER BY date DESC`
    )
    .all() as Array<{ date: string }>
  const studied = new Set(rows.map((r) => r.date))

  let streak = 0
  const cursor = new Date()
  if (!studied.has(today)) cursor.setDate(cursor.getDate() - 1)
  while (studied.has(localDate(cursor))) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return {
    todayMinutes: todayRow.minutes,
    todayPomos: todayRow.pomos,
    streakDays: streak
  }
}

function localDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// ================= notes（增量 upsert + 分视频归档，F-1/P-1） =================

/** 行 → NoteEntry（补全可选字段，兼容旧行缺列） */
function noteRowToEntry(row: {
  id: string | number
  created_at: number
  content: string
  video_title?: string
  bvid?: string
  timestamp_s?: number
  is_key?: number
  source?: string
}): NoteEntry {
  const ts = Number(row.timestamp_s ?? 0)
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    content: row.content,
    videoTitle: row.video_title || undefined,
    bvid: row.bvid || undefined,
    timestampS: ts > 0 ? ts : undefined,
    isKey: Number(row.is_key ?? 0) === 1,
    source: (row.source as NoteSource) || 'main'
  }
}

/**
 * 单条笔记增量保存（INSERT … ON CONFLICT(id) DO UPDATE）。
 * 取代整份覆盖：输入过程每 500ms 只提交变化的一条，不再 DELETE ALL + 全量重插。
 */
export function upsertNote(entry: NoteEntry): NoteEntry {
  const d = getDb()
  const now = entry.createdAt || Date.now()
  const id = entry.id || `n-${now}`
  if (!d) return { ...entry, id, createdAt: now }
  d.prepare(
    `INSERT INTO notes (id, created_at, video_title, content, tags, bvid, timestamp_s, is_key, source, parent_id)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, '')
     ON CONFLICT(id) DO UPDATE SET
       created_at = excluded.created_at,
       video_title = excluded.video_title,
       content = excluded.content,
       tags = excluded.tags,
       bvid = excluded.bvid,
       timestamp_s = excluded.timestamp_s,
       is_key = excluded.is_key,
       source = excluded.source,
       parent_id = excluded.parent_id`
  ).run(
    id,
    now,
    entry.videoTitle ?? '',
    entry.content,
    entry.bvid ?? '',
    entry.timestampS ?? 0,
    entry.isKey ? 1 : 0,
    entry.source ?? 'main'
  )
  return { ...entry, id, createdAt: now }
}

/** 按 id 删除单条笔记（不再整表清空） */
export function deleteNote(id: string): void {
  const d = getDb()
  if (!d || !id) return
  d.prepare('DELETE FROM notes WHERE id = ?').run(id)
}

/**
 * 兼容旧契约的整份保存：以入参集合为"应有集合"，删除集合外记录 + 逐条增量 upsert。
 * 语义与旧版"整份覆盖"一致，但内部为按 id 增量操作，不再先清空全表。
 */
export function saveNotesAll(entries: NoteEntry[]): void {
  const d = getDb()
  if (!d) return
  const keep = entries.map((e) => e.id || `n-${e.createdAt || Date.now()}`)
  d.prepare('BEGIN').run()
  try {
    if (keep.length === 0) {
      d.prepare('DELETE FROM notes').run()
    } else {
      const placeholders = keep.map(() => '?').join(',')
      d.prepare(`DELETE FROM notes WHERE id NOT IN (${placeholders})`).run(...keep)
    }
    for (const e of entries) {
      upsertNote(e)
    }
    d.prepare('COMMIT').run()
  } catch (err) {
    d.prepare('ROLLBACK').run()
    throw err
  }
}

/** 全量加载（新笔记在前：ORDER BY created_at DESC） */
export function loadNotesAll(): NoteEntry[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT id, created_at, video_title, content, bvid, timestamp_s, is_key, source
       FROM notes ORDER BY created_at DESC, id DESC`
    )
    .all() as Array<{
    id: string
    created_at: number
    video_title?: string
    content: string
    bvid?: string
    timestamp_s?: number
    is_key?: number
    source?: string
  }>
  return rows.map(noteRowToEntry)
}

/** 按视频归档读取（F-1）：某 BV 下的全部笔记，新笔记在前 */
export function loadNotesByVideo(bvid: string): NoteEntry[] {
  const d = getDb()
  if (!d || !bvid) return []
  const rows = d
    .prepare(
      `SELECT id, created_at, video_title, content, bvid, timestamp_s, is_key, source
       FROM notes WHERE bvid = ? ORDER BY created_at DESC, id DESC`
    )
    .all(bvid) as Array<{
    id: string
    created_at: number
    video_title?: string
    content: string
    bvid?: string
    timestamp_s?: number
    is_key?: number
    source?: string
  }>
  return rows.map(noteRowToEntry)
}

// ================= play_records（按视频学习进度，F-3 / M1 / M2 / M3） =================

const PLAY_STATUSES: ReadonlySet<string> = new Set(['planned', 'learning', 'done'])

/** 行 → PlayRecord（含标签聚合；tags_csv 由 SQL 子查询 GROUP_CONCAT 生成） */
function playRowToRecord(row: {
  bvid: string
  title: string
  duration_s: number
  watched_s: number
  last_position_s: number
  status: string
  viewed_count: number
  goal_rounds: number
  goal_deadline: string
  cover_url?: string
  author?: string
  tags_csv?: string | null
  created_at: number
  updated_at: number
}): PlayRecord {
  return {
    bvid: row.bvid,
    title: row.title,
    durationS: Number(row.duration_s ?? 0),
    watchedS: Number(row.watched_s ?? 0),
    lastPositionS: Number(row.last_position_s ?? 0),
    status: (PLAY_STATUSES.has(row.status) ? row.status : 'planned') as PlayStatus,
    viewedCount: Number(row.viewed_count ?? 0),
    goalRounds: Number(row.goal_rounds ?? 0),
    goalDeadline: row.goal_deadline ?? '',
    tags: (row.tags_csv ?? '').split(',').filter(Boolean),
    coverUrl: row.cover_url ?? '',
    author: row.author ?? '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

/** play_records 统一查询前缀（附带标签聚合子查询） */
const PLAY_RECORD_SELECT = `
  SELECT pr.bvid, pr.title, pr.duration_s, pr.watched_s, pr.last_position_s, pr.status,
         pr.viewed_count, pr.goal_rounds, pr.goal_deadline, pr.cover_url, pr.author,
         pr.created_at, pr.updated_at,
         (SELECT GROUP_CONCAT(tag) FROM play_record_tags WHERE bvid = pr.bvid) AS tags_csv
  FROM play_records pr`

/** 打开视频 / 进度心跳时 upsert 一条学习进度（打开时传 viewedCount 累加观看次数） */
export function upsertPlayRecord(rec: {
  bvid: string
  title?: string
  durationS?: number
  /** 新记录初始已观看时长（秒；仅 INSERT 生效，冲突更新不覆盖累计值） */
  watchedS?: number
  positionS?: number
  status?: PlayStatus
  /** 打开视频时传入：新累计观看次数（>0 生效） */
  viewedCount?: number
  /** 封面图 URL（bili-image:// 代理地址） */
  coverUrl?: string
  /** UP 主名称 */
  author?: string
}): PlayRecord | null {
  const d = getDb()
  if (!d || !rec.bvid) return null
  const now = Date.now()
  const prev = d.prepare(`SELECT * FROM play_records WHERE bvid = ?`).get(rec.bvid) as
    | {
        title: string
        duration_s: number
        watched_s: number
        last_position_s: number
        status: string
        viewed_count: number
        goal_rounds: number
        goal_deadline: string
        cover_url?: string
        author?: string
        created_at: number
        updated_at: number
      }
    | undefined
  const title = rec.title ?? prev?.title ?? ''
  const durationS = Math.max(prev?.duration_s ?? 0, rec.durationS ?? 0)
  const status =
    rec.status && PLAY_STATUSES.has(rec.status) ? rec.status : (prev?.status ?? 'planned')
  const viewedCount =
    Number.isFinite(rec.viewedCount) && (rec.viewedCount ?? 0) > 0
      ? Math.round(rec.viewedCount ?? 0)
      : (prev?.viewed_count ?? 0)
  const coverUrl = rec.coverUrl ?? prev?.cover_url ?? ''
  const author = rec.author ?? prev?.author ?? ''
  const watchedS = rec.watchedS ?? prev?.watched_s ?? 0
  d.prepare(
    `INSERT INTO play_records (bvid, title, duration_s, watched_s, last_position_s, status, viewed_count, goal_rounds, goal_deadline, cover_url, author, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bvid) DO UPDATE SET
       title = excluded.title,
       duration_s = excluded.duration_s,
       last_position_s = excluded.last_position_s,
       status = excluded.status,
       viewed_count = excluded.viewed_count,
       cover_url = excluded.cover_url,
       author = excluded.author,
       updated_at = excluded.updated_at`
  ).run(
    rec.bvid,
    title,
    durationS,
    watchedS,
    rec.positionS ?? prev?.last_position_s ?? 0,
    status,
    viewedCount,
    prev?.goal_rounds ?? 0,
    prev?.goal_deadline ?? '',
    coverUrl,
    author,
    prev?.created_at ?? now,
    now
  )
  return getPlayRecord(rec.bvid)
}

/**
 * 会话心跳累计观看时长（F-3/M3）：watched_s += delta、刷新 last_position_s、状态置为 learning。
 * 撮合到会话级（秒级 tick 由调用方节流），不逐帧跟踪，避免性能开销。
 * 进度百分比以 last_position_s 为准（M3 算法），watched_s 仅作累计时长统计。
 */
export function tickPlayRecord(tick: PlayRecordTick): PlayRecord | null {
  const d = getDb()
  if (!d || !tick.bvid) return null
  const delta =
    Number.isFinite(tick.watchedDeltaS) && tick.watchedDeltaS > 0
      ? Math.round(tick.watchedDeltaS)
      : 0
  const now = Date.now()
  const prev = d.prepare(`SELECT * FROM play_records WHERE bvid = ?`).get(tick.bvid) as
    | {
        title: string
        duration_s: number
        watched_s: number
        last_position_s: number
        viewed_count: number
        goal_rounds: number
        goal_deadline: string
        cover_url?: string
        author?: string
        created_at: number
        status: string
      }
    | undefined
  const positionS =
    Number.isFinite(tick.positionS) && tick.positionS > 0
      ? Math.round(tick.positionS)
      : (prev?.last_position_s ?? 0)
  const durationS = Math.max(prev?.duration_s ?? 0, tick.durationS ?? 0)
  const title = tick.title ?? prev?.title ?? ''
  d.prepare(
    `INSERT INTO play_records (bvid, title, duration_s, watched_s, last_position_s, status, viewed_count, goal_rounds, goal_deadline, cover_url, author, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'learning', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bvid) DO UPDATE SET
       title = excluded.title,
       duration_s = excluded.duration_s,
       watched_s = watched_s + excluded.watched_s,
       last_position_s = excluded.last_position_s,
       status = CASE WHEN status = 'done' THEN 'done' ELSE 'learning' END,
       updated_at = excluded.updated_at`
  ).run(
    tick.bvid,
    title,
    durationS,
    delta,
    positionS,
    prev?.viewed_count ?? 0,
    prev?.goal_rounds ?? 0,
    prev?.goal_deadline ?? '',
    prev?.cover_url ?? '',
    prev?.author ?? '',
    prev?.created_at ?? now,
    now
  )
  return getPlayRecord(tick.bvid)
}

/** 单条进度读取 */
export function getPlayRecord(bvid: string): PlayRecord | null {
  const d = getDb()
  if (!d || !bvid) return null
  const row = d.prepare(`${PLAY_RECORD_SELECT} WHERE pr.bvid = ?`).get(bvid) as
    | {
        bvid: string
        title: string
        duration_s: number
        watched_s: number
        last_position_s: number
        status: string
        viewed_count: number
        goal_rounds: number
        goal_deadline: string
        cover_url?: string
        author?: string
        tags_csv?: string | null
        created_at: number
        updated_at: number
      }
    | undefined
  return row ? playRowToRecord(row) : null
}

/** 全部视频学习进度（新学习在前） */
export function listPlayRecords(): PlayRecord[] {
  const d = getDb()
  if (!d) return []
  const rows = d.prepare(`${PLAY_RECORD_SELECT} ORDER BY pr.updated_at DESC`).all() as Array<{
    bvid: string
    title: string
    duration_s: number
    watched_s: number
    last_position_s: number
    status: string
    viewed_count: number
    goal_rounds: number
    goal_deadline: string
    cover_url?: string
    author?: string
    tags_csv?: string | null
    created_at: number
    updated_at: number
  }>
  return rows.map(playRowToRecord)
}

/**
 * 多维度筛选 + 排序（M1）：标题模糊 / 状态 / 标签（多选命中其一）/ 更新时间范围 / 四维排序。
 */
export function searchPlayRecords(filter: ProgressFilter): PlayRecord[] {
  const d = getDb()
  if (!d) return []
  const where: string[] = []
  const params: unknown[] = []
  const f = filter ?? {}
  const keyword = f.keyword?.trim()
  if (keyword) {
    where.push('pr.title LIKE ?')
    params.push(`%${keyword}%`)
  }
  if (f.status && f.status !== 'all') {
    where.push('pr.status = ?')
    params.push(f.status)
  }
  if (f.tags && f.tags.length > 0) {
    const tags = [...new Set(f.tags.filter(Boolean))]
    where.push(
      `pr.bvid IN (SELECT bvid FROM play_record_tags WHERE tag IN (${tags.map(() => '?').join(',')}))`
    )
    params.push(...tags)
  }
  if (f.dateRange && Number.isFinite(f.dateRange.start) && Number.isFinite(f.dateRange.end)) {
    where.push('pr.updated_at >= ? AND pr.updated_at <= ?')
    params.push(f.dateRange.start, f.dateRange.end)
  }
  // 排序列：进度用 CASE 把"时长未知（0）"归一为 0，避免 DESC 时未知时长排最前
  const orderCol: Record<NonNullable<ProgressFilter['sortBy']>, string> = {
    updated_at: 'pr.updated_at',
    progress:
      '(CASE WHEN pr.duration_s > 0 THEN CAST(pr.last_position_s AS REAL) / pr.duration_s ELSE 0 END)',
    duration: 'pr.duration_s',
    title: 'pr.title COLLATE NOCASE'
  }
  const sortBy = f.sortBy ?? 'updated_at'
  const col = orderCol[sortBy] ?? orderCol.updated_at
  const dir = f.sortOrder === 'asc' ? 'ASC' : 'DESC'
  const sql = `${PLAY_RECORD_SELECT}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${col} ${dir}, pr.updated_at DESC`
  const rows = d.prepare(sql).all(...params) as Array<{
    bvid: string
    title: string
    duration_s: number
    watched_s: number
    last_position_s: number
    status: string
    viewed_count: number
    goal_rounds: number
    goal_deadline: string
    cover_url?: string
    author?: string
    tags_csv?: string | null
    created_at: number
    updated_at: number
  }>
  return rows.map(playRowToRecord)
}

/** 标记某视频已学完 */
export function markPlayRecordDone(bvid: string): PlayRecord | null {
  const d = getDb()
  if (!d || !bvid) return null
  d.prepare(`UPDATE play_records SET status = 'done', updated_at = ? WHERE bvid = ?`).run(
    Date.now(),
    bvid
  )
  return getPlayRecord(bvid)
}

/**
 * 学习目标（F-5）：目标精读遍数 + 截止日期（goalRounds=0 清除目标）。
 * M3 的全局每日/每周目标存 settings.studyGoals（见 getProgressStats），此处仅课程级目标。
 */
export function setPlayGoal(
  bvid: string,
  goal: { goalRounds: number; goalDeadline?: string }
): PlayRecord | null {
  const d = getDb()
  if (!d || !bvid) return null
  const rounds = Math.max(0, Math.round(Number(goal.goalRounds) || 0))
  const deadline = goal.goalDeadline ?? ''
  const prev = d.prepare(`SELECT * FROM play_records WHERE bvid = ?`).get(bvid) as
    | {
        title: string
        duration_s: number
        watched_s: number
        last_position_s: number
        status: string
        viewed_count: number
        created_at: number
      }
    | undefined
  if (!prev) {
    d.prepare(
      `INSERT INTO play_records (bvid, title, duration_s, watched_s, last_position_s, status, viewed_count, goal_rounds, goal_deadline, cover_url, author, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)`
    ).run(bvid, '', 0, 0, 0, 'planned', 0, rounds, deadline, Date.now(), Date.now())
  } else {
    d.prepare(
      `UPDATE play_records SET goal_rounds = ?, goal_deadline = ?, updated_at = ? WHERE bvid = ?`
    ).run(rounds, deadline, Date.now(), bvid)
  }
  return getPlayRecord(bvid)
}

/* ===== M1 学习记录管理：删除 / 修改 / 标签 ===== */

/** 动态 UPDATE 构建：返回 SET 片段与参数（字段合法性校验 + 数值钳制） */
function buildPlayRecordUpdate(updates: PlayRecordUpdate): { sets: string[]; params: unknown[] } {
  const sets: string[] = []
  const params: unknown[] = []
  const u = updates ?? {}
  if (u.title !== undefined) {
    sets.push('title = ?')
    params.push(String(u.title))
  }
  if (u.durationS !== undefined) {
    sets.push('duration_s = ?')
    params.push(Math.max(0, Math.round(Number(u.durationS) || 0)))
  }
  if (u.watchedS !== undefined) {
    sets.push('watched_s = ?')
    params.push(Math.max(0, Math.round(Number(u.watchedS) || 0)))
  }
  if (u.lastPositionS !== undefined) {
    sets.push('last_position_s = ?')
    params.push(Math.max(0, Math.round(Number(u.lastPositionS) || 0)))
  }
  if (u.status !== undefined && PLAY_STATUSES.has(u.status)) {
    sets.push('status = ?')
    params.push(u.status)
  }
  if (u.viewedCount !== undefined) {
    sets.push('viewed_count = ?')
    params.push(Math.max(0, Math.round(Number(u.viewedCount) || 0)))
  }
  if (u.goalRounds !== undefined) {
    sets.push('goal_rounds = ?')
    params.push(Math.max(0, Math.round(Number(u.goalRounds) || 0)))
  }
  if (u.goalDeadline !== undefined) {
    sets.push('goal_deadline = ?')
    params.push(u.goalDeadline)
  }
  if (u.coverUrl !== undefined) {
    sets.push('cover_url = ?')
    params.push(u.coverUrl)
  }
  if (u.author !== undefined) {
    sets.push('author = ?')
    params.push(u.author)
  }
  return { sets, params }
}

/**
 * 单条修改（M1「调整进度」）：更新 watched_s / last_position_s / status / viewedCount /
 * 目标字段等，刷新 updated_at。仅传入的字段生效；记录不存在时以更新内容创建。
 */
export function updatePlayRecord(bvid: string, updates: PlayRecordUpdate): PlayRecord | null {
  const d = getDb()
  if (!d || !bvid) return null
  const prev = getPlayRecord(bvid)
  if (!prev) {
    return upsertPlayRecord({
      bvid,
      title: updates.title,
      durationS: updates.durationS,
      watchedS: updates.watchedS,
      positionS: updates.lastPositionS,
      status: updates.status,
      viewedCount: updates.viewedCount,
      coverUrl: updates.coverUrl,
      author: updates.author
    })
  }
  const { sets, params } = buildPlayRecordUpdate(updates)
  if (sets.length === 0) return prev
  d.prepare(`UPDATE play_records SET ${sets.join(', ')}, updated_at = ? WHERE bvid = ?`).run(
    ...params,
    Date.now(),
    bvid
  )
  return getPlayRecord(bvid)
}

/** 批量修改（M1 批量改状态等）：同一组 updates 应用到多条记录，事务保证原子性 */
export function batchUpdatePlayRecords(bvids: string[], updates: PlayRecordUpdate): number {
  const d = getDb()
  if (!d || !bvids || bvids.length === 0) return 0
  const { sets, params } = buildPlayRecordUpdate(updates)
  if (sets.length === 0) return 0
  const uniq = [...new Set(bvids.filter(Boolean))]
  d.prepare('BEGIN').run()
  try {
    const stmt = d.prepare(
      `UPDATE play_records SET ${sets.join(', ')}, updated_at = ? WHERE bvid = ?`
    )
    for (const bvid of uniq) {
      stmt.run(...params, Date.now(), bvid)
    }
    d.prepare('COMMIT').run()
    return uniq.length
  } catch (err) {
    try {
      d.prepare('ROLLBACK').run()
    } catch {
      // 忽略回滚失败
    }
    throw err
  }
}

/**
 * 删除单条学习记录（M1）。决策：默认不级联删除笔记（笔记独立归档）；
 * 始终级联删除该 bvid 的标签与学习会话明细。事务保证原子性。
 */
export function deletePlayRecord(bvid: string, opts?: { deleteNotes?: boolean }): boolean {
  const d = getDb()
  if (!d || !bvid) return false
  d.prepare('BEGIN').run()
  try {
    d.prepare('DELETE FROM play_records WHERE bvid = ?').run(bvid)
    d.prepare('DELETE FROM play_record_tags WHERE bvid = ?').run(bvid)
    d.prepare('DELETE FROM study_sessions WHERE bvid = ?').run(bvid)
    if (opts?.deleteNotes) {
      d.prepare('DELETE FROM notes WHERE bvid = ?').run(bvid)
    }
    d.prepare('COMMIT').run()
    return true
  } catch (err) {
    try {
      d.prepare('ROLLBACK').run()
    } catch {
      // 忽略回滚失败
    }
    throw err
  }
}

/** 批量删除（M1）：同 deletePlayRecord 语义，事务原子；返回实际删除条数 */
export function batchDeletePlayRecords(bvids: string[]): number {
  const d = getDb()
  if (!d || !bvids || bvids.length === 0) return 0
  const uniq = [...new Set(bvids.filter(Boolean))]
  d.prepare('BEGIN').run()
  try {
    for (const bvid of uniq) {
      d.prepare('DELETE FROM play_records WHERE bvid = ?').run(bvid)
      d.prepare('DELETE FROM play_record_tags WHERE bvid = ?').run(bvid)
      d.prepare('DELETE FROM study_sessions WHERE bvid = ?').run(bvid)
    }
    d.prepare('COMMIT').run()
    return uniq.length
  } catch (err) {
    try {
      d.prepare('ROLLBACK').run()
    } catch {
      // 忽略回滚失败
    }
    throw err
  }
}

/**
 * 设置某记录标签（M1）：整体替换（删除旧标签 + 批量插入新标签），
 * 大小写不敏感去重（"前端"与"Frontend"视为同一标签的边界情况，见 spec edge cases）。
 */
export function setPlayRecordTags(bvid: string, tags: string[]): PlayRecord | null {
  const d = getDb()
  if (!d || !bvid) return null
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const t of tags ?? []) {
    const tag = String(t).trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(tag)
  }
  d.prepare('BEGIN').run()
  try {
    d.prepare('DELETE FROM play_record_tags WHERE bvid = ?').run(bvid)
    const ins = d.prepare(
      'INSERT OR IGNORE INTO play_record_tags (bvid, tag, created_at) VALUES (?, ?, ?)'
    )
    for (const tag of uniq) {
      ins.run(bvid, tag, Date.now())
    }
    d.prepare('COMMIT').run()
  } catch (err) {
    try {
      d.prepare('ROLLBACK').run()
    } catch {
      // 忽略回滚失败
    }
    throw err
  }
  return getPlayRecord(bvid)
}

/** 全部标签（按使用次数降序，供筛选下拉与标签输入补全；M1） */
export function getAllPlayRecordTags(): string[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT tag FROM play_record_tags GROUP BY tag ORDER BY COUNT(*) DESC, tag COLLATE NOCASE`
    )
    .all() as Array<{ tag: string }>
  return rows.map((r) => r.tag)
}

/* ===== M3 学习会话明细（study_sessions）与统计 ===== */

/** 会话开始：打开视频时调用；返回会话 id（null = 存储不可用） */
export function recordStudySessionStart(
  bvid: string,
  source: SessionSource = 'manual'
): number | null {
  const d = getDb()
  if (!d || !bvid) return null
  const now = Date.now()
  const info = d
    .prepare(
      `INSERT INTO study_sessions (bvid, start_at, end_at, duration_s, source, created_at)
       VALUES (?, ?, 0, 0, ?, ?)`
    )
    .run(bvid, now, source, now)
  return Number(info.lastInsertRowid ?? 0) || null
}

/** 会话结束：关闭视频时调用；duration_s = (end - start) 秒；幂等（已结束不重写） */
export function recordStudySessionEnd(sessionId: number, endAt?: number): void {
  const d = getDb()
  if (!d || !sessionId) return
  const row = d
    .prepare('SELECT start_at, end_at FROM study_sessions WHERE id = ?')
    .get(sessionId) as { start_at: number; end_at: number } | undefined
  if (!row || row.end_at > 0) return
  const end = endAt ?? Date.now()
  const durationS = Math.max(0, Math.round((end - row.start_at) / 1000))
  d.prepare('UPDATE study_sessions SET end_at = ?, duration_s = ? WHERE id = ?').run(
    end,
    durationS,
    sessionId
  )
}

/** 某视频的学习会话明细（新会话在前；limit 缺省全量） */
export function getStudySessionsByVideo(bvid: string, limit?: number): StudySession[] {
  const d = getDb()
  if (!d || !bvid) return []
  const sql = `SELECT id, bvid, start_at, end_at, duration_s, source, created_at
               FROM study_sessions WHERE bvid = ? ORDER BY start_at DESC${limit ? ' LIMIT ?' : ''}`
  const rows = (limit ? d.prepare(sql).all(bvid, limit) : d.prepare(sql).all(bvid)) as Array<{
    id: number
    bvid: string
    start_at: number
    end_at: number
    duration_s: number
    source: string
    created_at: number
  }>
  return rows.map((r) => ({
    id: Number(r.id),
    bvid: r.bvid,
    startAt: Number(r.start_at),
    endAt: Number(r.end_at),
    durationS: Number(r.duration_s),
    source: (r.source === 'resume' || r.source === 'search' ? r.source : 'manual') as SessionSource,
    createdAt: Number(r.created_at)
  }))
}

/** 单日学习时长统计阈值：≥1 分钟才计入"有效学习日"（避免误开即关的噪声会话）；单位：秒（duration_s） */
const MIN_SESSION_SECONDS = 60

/**
 * 进度页概览统计（M3）：今日/本周（近 7 天）/本月学习时长、连续学习天数、
 * 课程状态计数、全局目标（settings.studyGoals）。
 * 学习时长口径：study_sessions.duration_s（打开视频的墙钟时长）。
 */
export function getProgressStats(): ProgressStats {
  const d = getDb()
  const goals = getSettings().studyGoals ?? { dailyMinutes: 0, weeklyDays: 0 }
  const empty: ProgressStats = {
    todayMinutes: 0,
    weekMinutes: 0,
    monthMinutes: 0,
    streakDays: 0,
    weekDaysStudied: 0,
    totalCourses: 0,
    doneCourses: 0,
    learningCourses: 0,
    plannedCourses: 0,
    dailyGoalMinutes: Number(goals.dailyMinutes) || 0,
    weeklyGoalDays: Number(goals.weeklyDays) || 0
  }
  if (!d) return empty

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfWeek = startOfToday - 6 * 86_400_000 // 近 7 天（含今天）
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

  const sumSince = (from: number): number => {
    const row = d
      .prepare(
        `SELECT COALESCE(SUM(duration_s), 0) AS s FROM study_sessions WHERE start_at >= ? AND duration_s >= 60`
      )
      .get(from) as { s: number }
    return Math.round(Number(row.s) / 60)
  }

  // 连续学习天数 + 本周学习天数：按本地日期聚合会话时长，≥1 分钟算有效学习日
  const rows = d
    .prepare(`SELECT start_at, duration_s FROM study_sessions WHERE duration_s >= 60`)
    .all() as Array<{ start_at: number; duration_s: number }>
  const byDay = new Map<string, number>()
  for (const r of rows) {
    const day = localDate(new Date(Number(r.start_at)))
    byDay.set(day, (byDay.get(day) ?? 0) + Number(r.duration_s))
  }
  let streak = 0
  const cursor = new Date()
  if ((byDay.get(localDate(cursor)) ?? 0) < MIN_SESSION_SECONDS)
    cursor.setDate(cursor.getDate() - 1)
  while ((byDay.get(localDate(cursor)) ?? 0) >= MIN_SESSION_SECONDS) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  let weekDaysStudied = 0
  {
    const weekCursor = new Date(startOfWeek)
    for (let i = 0; i < 7; i++) {
      if ((byDay.get(localDate(weekCursor)) ?? 0) >= MIN_SESSION_SECONDS) weekDaysStudied++
      weekCursor.setDate(weekCursor.getDate() + 1)
    }
  }

  const counts = d
    .prepare(`SELECT status, COUNT(*) AS c FROM play_records GROUP BY status`)
    .all() as Array<{ status: string; c: number }>
  const countOf = (s: PlayStatus): number => {
    const row = counts.find((r) => r.status === s)
    return Number(row?.c ?? 0)
  }
  const total = counts.reduce((sum, r) => sum + Number(r.c), 0)

  return {
    todayMinutes: sumSince(startOfToday),
    weekMinutes: sumSince(startOfWeek),
    monthMinutes: sumSince(startOfMonth),
    streakDays: streak,
    weekDaysStudied,
    totalCourses: total,
    doneCourses: countOf('done'),
    learningCourses: countOf('learning'),
    plannedCourses: countOf('planned'),
    dailyGoalMinutes: Number(goals.dailyMinutes) || 0,
    weeklyGoalDays: Number(goals.weeklyDays) || 0
  }
}

/* ===== M4 每日学习时长（柱状图数据） ===== */

/**
 * 近 N 天每日学习分钟（M4 柱状图）：按本地日期聚合 study_sessions（≥1 分钟会话），
 * 无数据日补 0，返回 [最旧 … 今天] 升序。
 */
export function getDailyStudyMinutes(days: number): DailyStat[] {
  const d = getDb()
  if (!d) return []
  const raw = Math.round(days)
  const n = Number.isFinite(raw) && raw >= 1 ? Math.min(90, raw) : 1
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const from = startOfToday - (n - 1) * 86_400_000
  const rows = d
    .prepare(
      `SELECT date(start_at / 1000, 'unixepoch', 'localtime') AS day, SUM(duration_s) AS s
       FROM study_sessions
       WHERE start_at >= ? AND duration_s >= 60
       GROUP BY day`
    )
    .all(from) as Array<{ day: string; s: number }>
  const map = new Map(rows.map((r) => [r.day, Math.round(Number(r.s) / 60)]))
  const out: DailyStat[] = []
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(startOfToday - i * 86_400_000)
    out.push({ date: localDate(day), minutes: map.get(localDate(day)) ?? 0 })
  }
  return out
}

/* ===== M5 数据备份（导出 / 导入 / 元数据） ===== */

/** 全量学习会话（备份导出用；新会话在前） */
export function getAllStudySessions(): StudySession[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT id, bvid, start_at, end_at, duration_s, source, created_at FROM study_sessions ORDER BY start_at DESC`
    )
    .all() as Array<{
    id: number
    bvid: string
    start_at: number
    end_at: number
    duration_s: number
    source: string
    created_at: number
  }>
  return rows.map((r) => ({
    id: Number(r.id),
    bvid: r.bvid,
    startAt: Number(r.start_at),
    endAt: Number(r.end_at),
    durationS: Number(r.duration_s),
    source: (r.source === 'resume' || r.source === 'search' ? r.source : 'manual') as SessionSource,
    createdAt: Number(r.created_at)
  }))
}

/** 组装备份数据快照（play_records + notes + sessions + tags + 学习目标） */
export function exportBackupData(): BackupFileData {
  return {
    playRecords: listPlayRecords(),
    notes: loadNotesAll(),
    studySessions: getAllStudySessions(),
    tags: getAllPlayRecordTags(),
    settings: (() => {
      const g = getSettings().studyGoals ?? { dailyMinutes: 0, weeklyDays: 0 }
      return { dailyMinutes: Number(g.dailyMinutes) || 0, weeklyDays: Number(g.weeklyDays) || 0 }
    })()
  }
}

/**
 * 恢复备份数据（M5）：事务原子。
 * - replace：清空 play_records / play_record_tags / study_sessions / notes 后整体写入
 * - merge ：play_records 同 bvid 取 updated_at 较新者；notes 按 id 保留现有（INSERT OR IGNORE）；
 *           sessions 追加（id 重建）；标签按记录聚合补入
 */
export function importBackupData(data: BackupFileData, mode: 'merge' | 'replace'): ImportResult {
  const d = getDb()
  if (!d) return { records: 0, notes: 0, sessions: 0 }
  const records = Array.isArray(data?.playRecords) ? data.playRecords : []
  const notes = Array.isArray(data?.notes) ? data.notes : []
  const sessions = Array.isArray(data?.studySessions) ? data.studySessions : []
  const result: ImportResult = { records: 0, notes: 0, sessions: 0 }

  d.prepare('BEGIN').run()
  try {
    if (mode === 'replace') {
      d.prepare('DELETE FROM play_records').run()
      d.prepare('DELETE FROM play_record_tags').run()
      d.prepare('DELETE FROM study_sessions').run()
      d.prepare('DELETE FROM notes').run()
    }

    const upsertRecord = d.prepare(
      `INSERT INTO play_records (bvid, title, duration_s, watched_s, last_position_s, status, viewed_count, goal_rounds, goal_deadline, cover_url, author, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bvid) DO UPDATE SET
         title = excluded.title,
         duration_s = excluded.duration_s,
         watched_s = excluded.watched_s,
         last_position_s = excluded.last_position_s,
         status = excluded.status,
         viewed_count = excluded.viewed_count,
         goal_rounds = excluded.goal_rounds,
         goal_deadline = excluded.goal_deadline,
         cover_url = excluded.cover_url,
         author = excluded.author,
         updated_at = excluded.updated_at`
    )
    // merge 模式：同 bvid 仅写 updated_at 较新者（取备份 vs 现有的较新值）
    let newerMap = new Map<string, number>()
    if (mode === 'merge') {
      const existing = d.prepare(`SELECT bvid, updated_at FROM play_records`).all() as Array<{
        bvid: string
        updated_at: number
      }>
      newerMap = new Map(existing.map((r) => [r.bvid, Number(r.updated_at)]))
    }
    for (const r of records) {
      if (
        mode === 'merge' &&
        newerMap.has(r.bvid) &&
        Number(r.updatedAt) < (newerMap.get(r.bvid) ?? 0)
      )
        continue
      upsertRecord.run(
        r.bvid,
        r.title ?? '',
        Number(r.durationS) || 0,
        Number(r.watchedS) || 0,
        Number(r.lastPositionS) || 0,
        PLAY_STATUSES.has(r.status) ? r.status : 'planned',
        Number(r.viewedCount) || 0,
        Number(r.goalRounds) || 0,
        r.goalDeadline ?? '',
        r.coverUrl ?? '',
        r.author ?? '',
        Number(r.createdAt) || Date.now(),
        Number(r.updatedAt) || Date.now()
      )
      result.records++
    }

    // 标签：按记录内嵌 tags 聚合补入（replace 表已清空，merge 为 INSERT OR IGNORE）
    const tagStmt = d.prepare(
      'INSERT OR IGNORE INTO play_record_tags (bvid, tag, created_at) VALUES (?, ?, ?)'
    )
    for (const r of records) {
      for (const t of r.tags ?? []) {
        if (String(t).trim()) tagStmt.run(r.bvid, String(t).trim(), Date.now())
      }
    }

    // 笔记：按 id（replace 表已清空；merge 保留现有）
    const insertNote = d.prepare(
      `INSERT OR IGNORE INTO notes (id, created_at, video_title, content, tags, bvid, timestamp_s, is_key, source, parent_id)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, '')`
    )
    for (const n of notes) {
      insertNote.run(
        String(n.id || `n-${n.createdAt || Date.now()}`),
        Number(n.createdAt) || Date.now(),
        n.videoTitle ?? '',
        n.content ?? '',
        n.bvid ?? '',
        Number(n.timestampS) || 0,
        n.isKey ? 1 : 0,
        n.source ?? 'main'
      )
      result.notes++
    }

    // 会话：追加（自增 id 重建）
    const insertSession = d.prepare(
      `INSERT INTO study_sessions (bvid, start_at, end_at, duration_s, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const s of sessions) {
      insertSession.run(
        s.bvid ?? '',
        Number(s.startAt) || Date.now(),
        Number(s.endAt) || 0,
        Number(s.durationS) || 0,
        s.source === 'resume' || s.source === 'search' ? s.source : 'manual',
        Number(s.createdAt) || Date.now()
      )
      result.sessions++
    }

    d.prepare('COMMIT').run()
  } catch (err) {
    try {
      d.prepare('ROLLBACK').run()
    } catch {
      // 忽略回滚失败
    }
    throw err
  }
  return result
}

/** 记录备份元数据（backup_meta 表） */
export function recordBackupMeta(meta: {
  filePath: string
  fileSize: number
  recordCount: number
  backupType: 'manual' | 'auto'
  createdAt: number
}): void {
  const d = getDb()
  if (!d) return
  d.prepare(
    `INSERT INTO backup_meta (file_path, file_size, record_count, backup_type, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(meta.filePath, meta.fileSize, meta.recordCount, meta.backupType, meta.createdAt)
}

/** 备份元数据列表（新备份在前；设置页数据管理展示） */
export function listBackupMeta(): BackupMeta[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT id, file_path, file_size, record_count, backup_type, created_at FROM backup_meta ORDER BY id DESC`
    )
    .all() as Array<{
    id: number
    file_path: string
    file_size: number
    record_count: number
    backup_type: string
    created_at: number
  }>
  return rows.map((r) => ({
    id: Number(r.id),
    filePath: r.file_path,
    fileSize: Number(r.file_size),
    recordCount: Number(r.record_count),
    backupType: r.backup_type === 'auto' ? 'auto' : 'manual',
    createdAt: Number(r.created_at)
  }))
}

// ================= feedback（用户反馈，R-1） =================

/** 提交反馈（本地落库，默认不上传） */
export function addFeedback(payload: {
  mode: string
  rating: number
  category?: string
  detail?: string
}): FeedbackEntry | null {
  const d = getDb()
  if (!d) return null
  const rating = Math.max(1, Math.min(5, Math.round(Number(payload.rating) || 5)))
  const now = Date.now()
  d.prepare(
    `INSERT INTO feedback (mode, rating, category, detail, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(payload.mode || 'general', rating, payload.category ?? '', payload.detail ?? '', now)
  const row = d
    .prepare(
      `SELECT id, mode, rating, category, detail, created_at AS createdAt FROM feedback ORDER BY id DESC LIMIT 1`
    )
    .get() as FeedbackEntry
  return row
}

export function listFeedback(): FeedbackEntry[] {
  const d = getDb()
  if (!d) return []
  return d
    .prepare(
      `SELECT id, mode, rating, category, detail, created_at AS createdAt FROM feedback ORDER BY id DESC`
    )
    .all() as FeedbackEntry[]
}

/** 反馈聚合（平均分 + 分类计数），供复盘页使用 */
export function getFeedbackStats(): FeedbackStats {
  const d = getDb()
  if (!d) return { count: 0, avgRating: 0, byCategory: {} }
  const rows = d.prepare(`SELECT rating, category FROM feedback`).all() as Array<{
    rating: number
    category: string
  }>
  if (rows.length === 0) return { count: 0, avgRating: 0, byCategory: {} }
  const byCategory: Record<string, number> = {}
  let sum = 0
  for (const r of rows) {
    sum += Number(r.rating)
    const cat: FeedbackCategory = (r.category as FeedbackCategory) || '其他'
    byCategory[cat] = (byCategory[cat] ?? 0) + 1
  }
  return {
    count: rows.length,
    avgRating: Math.round((sum / rows.length) * 10) / 10,
    byCategory
  }
}

// ================= events（匿名遥测，R-2，opt-in） =================

/** 记录匿名事件（仅计数/时长等非敏感字段；由 telemetry.ts 在开关开启时调用） */
export function recordEvent(
  domain: string,
  action: string,
  payload?: Record<string, unknown>
): void {
  const d = getDb()
  if (!d) return
  let payloadJson = ''
  try {
    payloadJson = payload ? JSON.stringify(payload) : ''
  } catch {
    payloadJson = ''
  }
  d.prepare(
    `INSERT INTO events (domain, action, payload_json, created_at) VALUES (?, ?, ?, ?)`
  ).run(domain, action, payloadJson, Date.now())
}

// ================= vocab（added_at） =================

export function addVocab(payload: {
  word: string
  phonetic?: string
  definition?: string
  example?: string
}): VocabEntry {
  const now = Date.now()
  const d = getDb()
  if (d) {
    d.prepare(
      `INSERT INTO vocab (word, phonetic, definition, example, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(word) DO UPDATE SET
         phonetic = excluded.phonetic,
         definition = excluded.definition,
         example = excluded.example`
    ).run(
      payload.word.trim(),
      payload.phonetic ?? '',
      payload.definition ?? '',
      payload.example ?? '',
      now
    )
    const row = d
      .prepare('SELECT * FROM vocab WHERE word = ?')
      .get(payload.word.trim()) as VocabEntry
    return row
  }
  return {
    id: Date.now(),
    word: payload.word.trim(),
    phonetic: payload.phonetic ?? '',
    definition: payload.definition ?? '',
    example: payload.example ?? '',
    createdAt: now
  }
}

export function listVocab(): VocabEntry[] {
  const d = getDb()
  if (!d) return []
  return d
    .prepare(
      `SELECT id, word, phonetic, definition, example, added_at AS createdAt FROM vocab ORDER BY id DESC`
    )
    .all() as VocabEntry[]
}

export function deleteVocab(id: number): void {
  const d = getDb()
  if (!d) return
  d.prepare('DELETE FROM vocab WHERE id = ?').run(id)
}

// ================= grammar_points（added_at） =================

export function addGrammarPoint(payload: { title: string; summary: string }): GrammarPoint {
  const now = Date.now()
  const d = getDb()
  if (d) {
    d.prepare('INSERT INTO grammar_points (title, summary, added_at) VALUES (?, ?, ?)').run(
      payload.title.trim(),
      payload.summary,
      now
    )
    return d
      .prepare(
        `SELECT id, title, summary, added_at AS createdAt FROM grammar_points ORDER BY id DESC LIMIT 1`
      )
      .get() as GrammarPoint
  }
  return { id: Date.now(), title: payload.title.trim(), summary: payload.summary, createdAt: now }
}

export function listGrammarPoints(): GrammarPoint[] {
  const d = getDb()
  if (!d) return []
  return d
    .prepare(
      `SELECT id, title, summary, added_at AS createdAt FROM grammar_points ORDER BY id DESC`
    )
    .all() as GrammarPoint[]
}

export function deleteGrammarPoint(id: number): void {
  const d = getDb()
  if (!d) return
  d.prepare('DELETE FROM grammar_points WHERE id = ?').run(id)
}

// ================= dict_entries（本地离线词典缓存/词库） =================

export interface LocalDictEntry {
  word: string
  phonetic?: string
  definition_cn: string
  definition_en?: string
  pos?: string
  collins?: number
  oxford?: number
  updated_at?: number
}

/** 查询本地离线词典条目 */
export function getLocalDictEntry(word: string): LocalDictEntry | null {
  const d = getDb()
  if (!d || !word) return null
  const cleaned = word.trim().toLowerCase()
  try {
    const row = d
      .prepare(
        `SELECT word, phonetic, definition_cn, definition_en, pos, collins, oxford, updated_at
         FROM dict_entries WHERE word = ? LIMIT 1`
      )
      .get(cleaned) as LocalDictEntry | undefined
    return row || null
  } catch {
    return null
  }
}

/** 写入或更新本地词典条目（缓存或预装词库） */
export function upsertLocalDictEntry(entry: LocalDictEntry): void {
  const d = getDb()
  if (!d || !entry.word) return
  const now = Date.now()
  try {
    d.prepare(
      `INSERT INTO dict_entries (word, phonetic, definition_cn, definition_en, pos, collins, oxford, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(word) DO UPDATE SET
         phonetic = excluded.phonetic,
         definition_cn = excluded.definition_cn,
         definition_en = excluded.definition_en,
         pos = excluded.pos,
         collins = excluded.collins,
         oxford = excluded.oxford,
         updated_at = excluded.updated_at`
    ).run(
      entry.word.trim().toLowerCase(),
      entry.phonetic ?? '',
      entry.definition_cn,
      entry.definition_en ?? '',
      entry.pos ?? '',
      entry.collins ?? 0,
      entry.oxford ?? 0,
      now
    )
  } catch {
    // 忽略异常，降级处理
  }
}

