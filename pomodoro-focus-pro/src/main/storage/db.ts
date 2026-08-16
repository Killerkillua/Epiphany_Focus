import { app } from 'electron'
import { createRequire } from 'module'
import { join } from 'path'
import type { GrammarPoint, VocabEntry } from '../../shared/ai'
import type { NoteEntry } from '../../shared/bili'
import type { DayTrendPoint, HeatmapCell, HomeSummary, ModeStat } from '../../shared/stats'

/**
 * 中央 SQLite 存储（方案 3.4，表名/字段名与规约一致）：
 *   sessions(id, mode, level, started_at, duration_planned, duration_actual,
 *            pomos_completed, interruptions, status, ended_at)
 *   study_stats(date, mode, minutes, pomos)
 *   notes(id, created_at, video_title, content, tags)
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
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  video_title TEXT DEFAULT '',
  content TEXT NOT NULL,
  tags TEXT DEFAULT ''
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

let db: SqliteLike | null = null
let warned = false

export function getDb(): SqliteLike | null {
  if (db) return db
  try {
    // better-sqlite3 为原生模块，动态 require 以便加载失败时优雅降级
    const require = createRequire(__filename)
    const Database = require('better-sqlite3') as new (file: string) => SqliteLike
    db = new Database(join(app.getPath('userData'), 'pomodoro.db'))
    db.pragma('journal_mode = WAL')
    db.exec(SCHEMA)
    return db
  } catch (err) {
    if (!warned) {
      warned = true
      console.warn('[storage] SQLite 不可用，统计/生词本等功能不可用:', err instanceof Error ? err.message : err)
    }
    return null
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

export function recordStudyStats(date: string, mode: string, minutes: number, pomos: number): void {
  const d = getDb()
  if (!d || minutes <= 0) return
  d.prepare(
    `INSERT INTO study_stats (date, mode, minutes, pomos) VALUES (?, ?, ?, ?)
     ON CONFLICT(date, mode) DO UPDATE SET
       minutes = minutes + excluded.minutes,
       pomos = pomos + excluded.pomos`
  ).run(date, mode, Math.max(1, Math.round(minutes)), Math.max(0, pomos))
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
         SUM(duration_actual) / 60000 AS minutes,
         COUNT(*) AS sessions
       FROM sessions
       WHERE status = 'done' AND ended_at IS NOT NULL
       GROUP BY weekday, hour`
    )
    .all() as Array<{ weekday: number; hour: number; minutes: number; sessions: number }>
  return rows.map((r) => ({
    weekday: Number(r.weekday),
    hour: Number(r.hour),
    minutes: Number(r.minutes),
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

// ================= notes（整份覆盖，兼容 B 站悬浮面板契约） =================

export function saveNotesAll(entries: NoteEntry[]): void {
  const d = getDb()
  if (!d) return
  const tx = d.prepare('DELETE FROM notes')
  const ins = d.prepare(
    `INSERT INTO notes (created_at, video_title, content, tags) VALUES (?, ?, ?, ?)`
  )
  d.prepare('BEGIN').run()
  try {
    tx.run()
    for (const e of entries) {
      ins.run(e.createdAt ?? Date.now(), '', e.content, '')
    }
    d.prepare('COMMIT').run()
  } catch (err) {
    d.prepare('ROLLBACK').run()
    throw err
  }
}

export function loadNotesAll(): NoteEntry[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(`SELECT id, created_at AS createdAt, content FROM notes ORDER BY id`)
    .all() as Array<{ id: number; createdAt: number; content: string }>
  return rows.map((r) => ({ id: String(r.id), createdAt: r.createdAt, content: r.content }))
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
