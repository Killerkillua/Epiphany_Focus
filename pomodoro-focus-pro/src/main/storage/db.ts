import { app } from 'electron'
import { createRequire } from 'module'
import { join } from 'path'
import type { GrammarPoint, VocabEntry } from '../../shared/ai'
import type { NoteEntry, NoteSource } from '../../shared/bili'
import type {
  DayTrendPoint,
  FeedbackCategory,
  FeedbackEntry,
  FeedbackStats,
  HeatmapCell,
  HomeSummary,
  ModeStat,
  PlayRecord,
  PlayRecordTick,
  PlayStatus
} from '../../shared/stats'

/**
 * 中央 SQLite 存储（方案 3.4，表名/字段名与规约一致）：
 *   sessions(id, mode, level, started_at, duration_planned, duration_actual,
 *            pomos_completed, interruptions, status, ended_at)
 *   study_stats(date, mode, minutes, pomos)
 *   notes(id, created_at, video_title, content, tags, bvid, timestamp_s, is_key, source, parent_id)
 *   play_records(bvid, title, duration_s, watched_s, last_position_s, status,
 *                viewed_count, goal_rounds, goal_deadline, created_at, updated_at)
 *   feedback(id, mode, rating, category, detail, created_at)
 *   events(id, domain, action, payload_json, created_at)   —— 匿名遥测（R-2）
 *   vocab(id, word, phonetic, definition, example, added_at)
 *   grammar_points(id, title, summary, added_at)
 *   ai_conversations(id, mode, messages_json, created_at)
 */

interface SqliteLike {
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
-- 按视频学习进度（F-3）：bvid 主键，会话级撮合，非逐帧跟踪
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
function migrateNotesTable(d: SqliteLike): void {
  const cols = d.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>
  const names = new Set(cols.map((c) => c.name))
  if (names.has('bvid') && names.has('timestamp_s') && names.has('is_key') && names.has('source')) return
  try {
    d.exec(`
      ALTER TABLE notes RENAME TO notes_legacy;
      ${NOTES_TABLE_DDL};
      INSERT INTO notes (id, created_at, video_title, content, tags, bvid, timestamp_s, is_key, source, parent_id)
        SELECT CAST(id AS TEXT), created_at, video_title, content, tags, '', 0, 0, 'main', '' FROM notes_legacy;
      DROP TABLE notes_legacy;
    `)
    console.info('[storage] notes 表已迁移：TEXT 主键 + bvid/timestamp_s/is_key/source 字段')
  } catch (err) {
    console.warn('[storage] notes 表迁移失败，沿用旧结构:', err instanceof Error ? err.message : err)
  }
}

let db: SqliteLike | null = null
let warned = false

export function getDb(): SqliteLike | null {
  if (db) return db
  try {
    // 测试注入：POMODORO_DB_PATH 指向隔离的临时数据库（生产环境不设置，走 userData）
    const dbPath = process.env.POMODORO_DB_PATH || join(app.getPath('userData'), 'pomodoro.db')

    // 测试专用驱动：系统 Node 内置 SQLite（better-sqlite3 按 Electron ABI 编译，
    // 纯 Node 的 vitest 无法加载原生绑定）。生产环境始终走 better-sqlite3 分支。
    if (process.env.POMODORO_DB_DRIVER === 'node:sqlite') {
      const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')
      const sync = new DatabaseSync(dbPath)
      sync.exec('PRAGMA journal_mode = WAL')
      sync.exec(SCHEMA)
      migrateNotesTable(sync as unknown as SqliteLike)
      db = sync as unknown as SqliteLike
      return db
    }

    // better-sqlite3 为原生模块，动态 require 以便加载失败时优雅降级
    const require = createRequire(__filename)
    const Database = require('better-sqlite3') as new (file: string) => SqliteLike
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec(SCHEMA)
    migrateNotesTable(db)
    return db
  } catch (err) {
    if (!warned) {
      warned = true
      console.warn('[storage] SQLite 不可用，统计/生词本等功能不可用:', err instanceof Error ? err.message : err)
    }
    return null
  }
}

/** 关闭并释放数据库连接（测试隔离用；生产环境无需调用） */
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
  ).run(opts.durationActual, opts.pomosCompleted, opts.interruptions, opts.status, Date.now(), sessionId)
}

// ================= study_stats =================

/** 不足 1 分钟的时长不记录（与"已学习 ≥1 分钟计入统计"的语义一致） */
const MIN_RECORD_MS = 60_000

/**
 * 记录学习统计（study_stats UPSERT 累加）。
 * 时间口径统一：调用方只传原始毫秒，分钟换算与取整只在此处发生一次，
 * 避免多路径 Math.ceil / Math.round 不一致造成 ±1 分钟偏差。
 */
export function recordStudyStats(date: string, mode: string, elapsedMs: number, pomos: number): void {
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
    .prepare(`SELECT mode, SUM(minutes) AS minutes, SUM(pomos) AS pomos FROM study_stats GROUP BY mode ORDER BY minutes DESC`)
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

  const todayRow = d.prepare(
    `SELECT COALESCE(SUM(minutes),0) AS minutes,
            COALESCE(SUM(pomos),0) AS pomos
     FROM study_stats WHERE date = ?`
  ).get(today) as { minutes: number; pomos: number }

  // 连续天数回溯全部有学习记录的日期（study_stats 按天聚合，每天最多 1 行，
  // 全量加载开销可忽略；窗口化会把超过窗口的连续记录截断，导致 streak 偏小）
  const rows = d.prepare(
    `SELECT date FROM study_stats
     GROUP BY date HAVING SUM(minutes) > 0
     ORDER BY date DESC`
  ).all() as Array<{ date: string }>
  const studied = new Set(rows.map(r => r.date))

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

// ================= play_records（按视频学习进度，F-3） =================

const PLAY_STATUSES: ReadonlySet<string> = new Set(['planned', 'learning', 'done'])

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
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

/** 打开视频 / 进度心跳时 upsert 一条学习进度（打开时传 viewedCount 累加观看次数） */
export function upsertPlayRecord(rec: {
  bvid: string
  title?: string
  durationS?: number
  positionS?: number
  status?: PlayStatus
  /** 打开视频时传入：新累计观看次数（>0 生效） */
  viewedCount?: number
}): PlayRecord | null {
  const d = getDb()
  if (!d || !rec.bvid) return null
  const now = Date.now()
  const prev = d
    .prepare(`SELECT * FROM play_records WHERE bvid = ?`)
    .get(rec.bvid) as
    | {
        title: string
        duration_s: number
        watched_s: number
        last_position_s: number
        status: string
        viewed_count: number
        goal_rounds: number
        goal_deadline: string
        created_at: number
        updated_at: number
      }
    | undefined
  const title = rec.title ?? prev?.title ?? ''
  const durationS = Math.max(prev?.duration_s ?? 0, rec.durationS ?? 0)
  const status = rec.status && PLAY_STATUSES.has(rec.status) ? rec.status : (prev?.status ?? 'planned')
  const viewedCount = Number.isFinite(rec.viewedCount) && (rec.viewedCount ?? 0) > 0
    ? Math.round(rec.viewedCount ?? 0)
    : (prev?.viewed_count ?? 0)
  d.prepare(
    `INSERT INTO play_records (bvid, title, duration_s, watched_s, last_position_s, status, viewed_count, goal_rounds, goal_deadline, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bvid) DO UPDATE SET
       title = excluded.title,
       duration_s = excluded.duration_s,
       last_position_s = excluded.last_position_s,
       status = excluded.status,
       viewed_count = excluded.viewed_count,
       updated_at = excluded.updated_at`
  ).run(
    rec.bvid,
    title,
    durationS,
    prev?.watched_s ?? 0,
    rec.positionS ?? prev?.last_position_s ?? 0,
    status,
    viewedCount,
    prev?.goal_rounds ?? 0,
    prev?.goal_deadline ?? '',
    prev?.created_at ?? now,
    now
  )
  return getPlayRecord(rec.bvid)
}

/**
 * 会话心跳累计观看时长（F-3）：watched_s += delta、刷新 last_position_s、状态置为 learning。
 * 撮合到会话级（秒级 tick 由调用方节流），不逐帧跟踪，避免性能开销。
 */
export function tickPlayRecord(tick: PlayRecordTick): PlayRecord | null {
  const d = getDb()
  if (!d || !tick.bvid) return null
  const delta = Number.isFinite(tick.watchedDeltaS) && tick.watchedDeltaS > 0 ? Math.round(tick.watchedDeltaS) : 0
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
        created_at: number
        status: string
      }
    | undefined
  const positionS = Number.isFinite(tick.positionS) && tick.positionS > 0 ? Math.round(tick.positionS) : (prev?.last_position_s ?? 0)
  const durationS = Math.max(prev?.duration_s ?? 0, tick.durationS ?? 0)
  const title = tick.title ?? prev?.title ?? ''
  d.prepare(
    `INSERT INTO play_records (bvid, title, duration_s, watched_s, last_position_s, status, viewed_count, goal_rounds, goal_deadline, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'learning', ?, ?, ?, ?, ?)
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
    prev?.created_at ?? now,
    now
  )
  return getPlayRecord(tick.bvid)
}

/** 单条进度读取 */
export function getPlayRecord(bvid: string): PlayRecord | null {
  const d = getDb()
  if (!d || !bvid) return null
  const row = d.prepare(`SELECT * FROM play_records WHERE bvid = ?`).get(bvid) as
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
  const rows = d
    .prepare(
      `SELECT bvid, title, duration_s, watched_s, last_position_s, status, viewed_count, goal_rounds, goal_deadline, created_at, updated_at
       FROM play_records ORDER BY updated_at DESC`
    )
    .all() as Array<{
    bvid: string
    title: string
    duration_s: number
    watched_s: number
    last_position_s: number
    status: string
    viewed_count: number
    goal_rounds: number
    goal_deadline: string
    created_at: number
    updated_at: number
  }>
  return rows.map(playRowToRecord)
}

/** 标记某视频已学完 */
export function markPlayRecordDone(bvid: string): PlayRecord | null {
  const d = getDb()
  if (!d || !bvid) return null
  d.prepare(`UPDATE play_records SET status = 'done', updated_at = ? WHERE bvid = ?`).run(Date.now(), bvid)
  return getPlayRecord(bvid)
}

/** 学习目标（F-5）：目标精读遍数 + 截止日期（goalRounds=0 清除目标） */
export function setPlayGoal(
  bvid: string,
  goal: { goalRounds: number; goalDeadline?: string }
): PlayRecord | null {
  const d = getDb()
  if (!d || !bvid) return null
  const rounds = Math.max(0, Math.round(Number(goal.goalRounds) || 0))
  const deadline = goal.goalDeadline ?? ''
  const prev = d.prepare(`SELECT * FROM play_records WHERE bvid = ?`).get(bvid) as
    | { title: string; duration_s: number; watched_s: number; last_position_s: number; status: string; viewed_count: number; created_at: number }
    | undefined
  if (!prev) {
    d.prepare(
      `INSERT INTO play_records (bvid, title, duration_s, watched_s, last_position_s, status, viewed_count, goal_rounds, goal_deadline, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(bvid, '', 0, 0, 0, 'planned', 0, rounds, deadline, Date.now(), Date.now())
  } else {
    d.prepare(`UPDATE play_records SET goal_rounds = ?, goal_deadline = ?, updated_at = ? WHERE bvid = ?`).run(
      rounds,
      deadline,
      Date.now(),
      bvid
    )
  }
  return getPlayRecord(bvid)
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
    .prepare(`SELECT id, mode, rating, category, detail, created_at AS createdAt FROM feedback ORDER BY id DESC LIMIT 1`)
    .get() as FeedbackEntry
  return row
}

export function listFeedback(): FeedbackEntry[] {
  const d = getDb()
  if (!d) return []
  return d
    .prepare(`SELECT id, mode, rating, category, detail, created_at AS createdAt FROM feedback ORDER BY id DESC`)
    .all() as FeedbackEntry[]
}

/** 反馈聚合（平均分 + 分类计数），供复盘页使用 */
export function getFeedbackStats(): FeedbackStats {
  const d = getDb()
  if (!d) return { count: 0, avgRating: 0, byCategory: {} }
  const rows = d
    .prepare(`SELECT rating, category FROM feedback`)
    .all() as Array<{ rating: number; category: string }>
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
export function recordEvent(domain: string, action: string, payload?: Record<string, unknown>): void {
  const d = getDb()
  if (!d) return
  let payloadJson = ''
  try {
    payloadJson = payload ? JSON.stringify(payload) : ''
  } catch {
    payloadJson = ''
  }
  d.prepare(`INSERT INTO events (domain, action, payload_json, created_at) VALUES (?, ?, ?, ?)`).run(
    domain,
    action,
    payloadJson,
    Date.now()
  )
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
    ).run(payload.word.trim(), payload.phonetic ?? '', payload.definition ?? '', payload.example ?? '', now)
    const row = d.prepare('SELECT * FROM vocab WHERE word = ?').get(payload.word.trim()) as VocabEntry
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
      .prepare(`SELECT id, title, summary, added_at AS createdAt FROM grammar_points ORDER BY id DESC LIMIT 1`)
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
