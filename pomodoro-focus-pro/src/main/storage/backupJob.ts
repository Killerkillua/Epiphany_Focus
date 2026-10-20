import { normalizeVocabWord, type VocabEntry } from '../../shared/ai'
import { BACKUP_VERSION, type BackupFile, type BackupFileData, type ImportResult } from '../../shared/backup'
import type { NoteEntry } from '../../shared/bili'
import type { PlayRecord, PlayStatus, SessionSource, StudySession } from '../../shared/stats'
import type { FocusSessionBackup, InterruptionEvent, Task, TaskBackupSlice } from '../../shared/task'
import { rebuildHeatmap } from './heatmap'
import type { SqliteLike } from './sqliteOpen'

const PLAY_STATUSES = new Set(['planned', 'learning', 'done'])
const PRIORITIES = new Set(['high', 'medium', 'low'])
const TASK_STATUSES = new Set(['todo', 'done', 'archived'])

function clampEstimate(value: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 1
  return Math.min(48, Math.max(1, n))
}

function sessionSource(value: string): SessionSource {
  return value === 'resume' || value === 'search' ? value : 'manual'
}

/** 全量快照（不受列表上限影响）。Worker 与主进程导出共用。 */
export function collectBackupData(
  d: SqliteLike,
  goals: { dailyMinutes: number; weeklyDays: number }
): BackupFileData {
  const records = d
    .prepare(
      `SELECT pr.bvid, pr.title, pr.duration_s, pr.watched_s, pr.last_position_s, pr.status,
              pr.viewed_count, pr.goal_rounds, pr.goal_deadline, pr.cover_url, pr.author,
              pr.created_at, pr.updated_at,
              (SELECT GROUP_CONCAT(tag) FROM play_record_tags WHERE bvid = pr.bvid) AS tags_csv
       FROM play_records pr ORDER BY pr.updated_at DESC`
    )
    .all() as Array<Record<string, unknown>>
  const notes = d
    .prepare(
      `SELECT id, created_at, video_title, content, bvid, timestamp_s, is_key, source
       FROM notes ORDER BY created_at DESC, id DESC`
    )
    .all() as Array<Record<string, unknown>>
  const sessions = d
    .prepare(
      `SELECT id, bvid, start_at, end_at, duration_s, source, created_at
       FROM study_sessions ORDER BY start_at DESC`
    )
    .all() as Array<Record<string, unknown>>
  const tags = d
    .prepare(
      `SELECT tag FROM play_record_tags GROUP BY tag ORDER BY COUNT(*) DESC, tag COLLATE NOCASE`
    )
    .all() as Array<{ tag: string }>
  const vocab = d
    .prepare(
      `SELECT id, word, phonetic, definition, example, added_at AS createdAt FROM vocab ORDER BY id ASC`
    )
    .all() as Array<Record<string, unknown>>

  return {
    playRecords: records.map(playRow),
    notes: notes.map(noteRow),
    studySessions: sessions.map(studyRow),
    tags: tags.map((r) => r.tag),
    settings: {
      dailyMinutes: Number(goals.dailyMinutes) || 0,
      weeklyDays: Number(goals.weeklyDays) || 0
    },
    vocab: vocab.map(vocabRow),
    ...collectTaskBackup(d)
  }
}

export function collectTaskBackup(d: SqliteLike): TaskBackupSlice {
  const tasks = d.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as Array<
    Record<string, unknown>
  >
  const focus = d
    .prepare(
      `SELECT id, task_id, level, started_at, ended_at, duration_planned, duration_actual,
              pomos_completed, interruptions, internal_interruptions, external_interruptions,
              status, pomo_credited
       FROM sessions WHERE mode = 'focus' ORDER BY started_at ASC`
    )
    .all() as Array<Record<string, unknown>>
  const events = d
    .prepare(
      `SELECT id, session_id, task_id, type, note, elapsed_ms, created_at
       FROM interruption_events ORDER BY created_at ASC`
    )
    .all() as Array<Record<string, unknown>>
  return {
    tasks: tasks.map(taskRow),
    focusSessions: focus.map(focusRow),
    interruptionEvents: events.map(eventRow)
  }
}

export function assembleBackupFile(
  d: SqliteLike,
  goals: { dailyMinutes: number; weeklyDays: number }
): BackupFile {
  return {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    data: collectBackupData(d, goals)
  }
}

export function applyContentBackup(
  d: SqliteLike,
  data: BackupFileData,
  mode: 'merge' | 'replace'
): ImportResult {
  const records = Array.isArray(data?.playRecords) ? data.playRecords : []
  const notes = Array.isArray(data?.notes) ? data.notes : []
  const sessions = Array.isArray(data?.studySessions) ? data.studySessions : []
  const vocab = Array.isArray(data?.vocab) ? data.vocab : []
  const result: ImportResult = { records: 0, notes: 0, sessions: 0, vocab: 0 }
  d.prepare('BEGIN').run()
  try {
    if (mode === 'replace') {
      d.prepare('DELETE FROM play_records').run()
      d.prepare('DELETE FROM play_record_tags').run()
      d.prepare('DELETE FROM study_sessions').run()
      d.prepare('DELETE FROM notes').run()
      d.prepare('DELETE FROM vocab').run()
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
    let newerMap = new Map<string, number>()
    if (mode === 'merge') {
      const existing = d.prepare(`SELECT bvid, updated_at FROM play_records`).all() as Array<{
        bvid: string
        updated_at: number
      }>
      newerMap = new Map(existing.map((r) => [r.bvid, Number(r.updated_at)]))
    }
    for (const r of records) {
      if (mode === 'merge' && newerMap.has(r.bvid) && Number(r.updatedAt) < (newerMap.get(r.bvid) ?? 0))
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
    const tagStmt = d.prepare(
      'INSERT OR IGNORE INTO play_record_tags (bvid, tag, created_at) VALUES (?, ?, ?)'
    )
    for (const r of records) {
      for (const t of r.tags ?? []) {
        if (String(t).trim()) tagStmt.run(r.bvid, String(t).trim(), Date.now())
      }
    }
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
    const insertSession = d.prepare(
      `INSERT INTO study_sessions (bvid, start_at, end_at, duration_s, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const s of sessions) {
      insertSession.run(
        s.bvid ?? '',
        Number(s.startAt) || Date.now(),
        Number(s.endAt) || 0,
        Number(s.durationS) || 0,
        sessionSource(String(s.source ?? '')),
        Number(s.createdAt) || Date.now()
      )
      result.sessions++
    }
    result.vocab = writeVocab(d, vocab, mode)
    d.prepare('COMMIT').run()
  } catch (err) {
    try {
      d.prepare('ROLLBACK').run()
    } catch {
      /* 忽略回滚失败 */
    }
    throw err
  }
  return result
}

export function applyTaskBackup(
  d: SqliteLike,
  data: TaskBackupSlice,
  mode: 'merge' | 'replace'
): { tasks: number; focusSessions: number; interruptions: number } {
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const sessions = Array.isArray(data.focusSessions) ? data.focusSessions : []
  const events = Array.isArray(data.interruptionEvents) ? data.interruptionEvents : []
  const result = { tasks: 0, focusSessions: 0, interruptions: 0 }
  d.prepare('BEGIN').run()
  try {
    if (mode === 'replace') {
      d.prepare('DELETE FROM interruption_events').run()
      d.prepare(`DELETE FROM sessions WHERE mode = 'focus'`).run()
      d.prepare('DELETE FROM tasks').run()
    }
    writeTasks(d, tasks, mode)
    result.tasks = tasks.length
    writeFocusSessions(d, sessions)
    result.focusSessions = sessions.length
    writeInterruptions(d, events)
    result.interruptions = events.length
    rebuildHeatmap(d)
    d.prepare('COMMIT').run()
  } catch (err) {
    try {
      d.prepare('ROLLBACK').run()
    } catch {
      /* 忽略回滚失败 */
    }
    throw err
  }
  return result
}

function playRow(row: Record<string, unknown>): PlayRecord {
  const status = String(row.status ?? 'planned')
  return {
    bvid: String(row.bvid),
    title: String(row.title ?? ''),
    durationS: Number(row.duration_s ?? 0),
    watchedS: Number(row.watched_s ?? 0),
    lastPositionS: Number(row.last_position_s ?? 0),
    status: (PLAY_STATUSES.has(status) ? status : 'planned') as PlayStatus,
    viewedCount: Number(row.viewed_count ?? 0),
    goalRounds: Number(row.goal_rounds ?? 0),
    goalDeadline: String(row.goal_deadline ?? ''),
    tags: String(row.tags_csv ?? '')
      .split(',')
      .filter(Boolean),
    coverUrl: String(row.cover_url ?? ''),
    author: String(row.author ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function noteRow(row: Record<string, unknown>): NoteEntry {
  const ts = Number(row.timestamp_s ?? 0)
  const bvid = String(row.bvid ?? '')
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    content: String(row.content ?? ''),
    videoTitle: row.video_title ? String(row.video_title) : undefined,
    bvid: bvid || undefined,
    timestampS: ts > 0 ? ts : undefined,
    isKey: Number(row.is_key ?? 0) === 1,
    source: (row.source as NoteEntry['source']) || 'main'
  }
}

function studyRow(row: Record<string, unknown>): StudySession {
  return {
    id: Number(row.id),
    bvid: String(row.bvid ?? ''),
    startAt: Number(row.start_at),
    endAt: Number(row.end_at),
    durationS: Number(row.duration_s),
    source: sessionSource(String(row.source ?? '')),
    createdAt: Number(row.created_at)
  }
}

function vocabRow(row: Record<string, unknown>): VocabEntry {
  return {
    id: Number(row.id),
    word: String(row.word ?? ''),
    phonetic: String(row.phonetic ?? ''),
    definition: String(row.definition ?? ''),
    example: String(row.example ?? ''),
    createdAt: Number(row.createdAt ?? row.added_at ?? 0)
  }
}

/** 备份非空优先；否则留本地（双方都非空 → 备份；仅一方非空 → 非空方） */
function preferBackupField(backup: string, local: string): string {
  return backup || local
}

/**
 * 写入生词本：
 * - replace：调用方已 DELETE；此处按备份整行插入
 * - merge：按 word 唯一；字段级空不盖非空、都有则备份优先；added_at 取较早
 */
function writeVocab(
  d: SqliteLike,
  entries: VocabEntry[],
  mode: 'merge' | 'replace'
): number {
  const localByWord = new Map<string, VocabEntry>()
  if (mode === 'merge') {
    const rows = d
      .prepare(
        `SELECT id, word, phonetic, definition, example, added_at AS createdAt FROM vocab`
      )
      .all() as Array<Record<string, unknown>>
    for (const row of rows) {
      const entry = vocabRow(row)
      const key = normalizeVocabWord(entry.word)
      if (key) localByWord.set(key, { ...entry, word: key })
    }
  }
  const upsert = d.prepare(
    `INSERT INTO vocab (word, phonetic, definition, example, added_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(word) DO UPDATE SET
       phonetic = excluded.phonetic,
       definition = excluded.definition,
       example = excluded.example,
       added_at = excluded.added_at`
  )
  let written = 0
  for (const raw of entries) {
    const word = normalizeVocabWord(String(raw.word ?? ''))
    if (!word) continue
    const backup: VocabEntry = {
      id: Number(raw.id) || 0,
      word,
      phonetic: String(raw.phonetic ?? ''),
      definition: String(raw.definition ?? ''),
      example: String(raw.example ?? ''),
      createdAt: Number(raw.createdAt) || Date.now()
    }
    const local = localByWord.get(word)
    if (mode === 'merge' && local) {
      upsert.run(
        word,
        preferBackupField(backup.phonetic, local.phonetic),
        preferBackupField(backup.definition, local.definition),
        preferBackupField(backup.example, local.example),
        Math.min(local.createdAt || backup.createdAt, backup.createdAt || local.createdAt)
      )
    } else {
      upsert.run(
        word,
        backup.phonetic,
        backup.definition,
        backup.example,
        backup.createdAt || Date.now()
      )
    }
    written++
  }
  return written
}

function taskRow(row: Record<string, unknown>): Task {
  const priority = String(row.priority ?? 'medium')
  const status = String(row.status ?? 'todo')
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    priority: (PRIORITIES.has(priority) ? priority : 'medium') as Task['priority'],
    estimatedPomodoros: Number(row.estimated_pomodoros ?? 1),
    actualPomodoros: Number(row.actual_pomodoros ?? 0),
    status: (TASK_STATUSES.has(status) ? status : 'todo') as Task['status'],
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at)
  }
}

function focusRow(row: Record<string, unknown>): FocusSessionBackup {
  return {
    id: Number(row.id),
    taskId: (row.task_id as string) || null,
    level: String(row.level ?? 'L0'),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    durationPlanned: Number(row.duration_planned ?? 0),
    durationActual: Number(row.duration_actual ?? 0),
    pomosCompleted: Number(row.pomos_completed ?? 0),
    interruptions: Number(row.interruptions ?? 0),
    internalInterruptions: Number(row.internal_interruptions ?? 0),
    externalInterruptions: Number(row.external_interruptions ?? 0),
    status: String(row.status ?? 'done'),
    pomoCredited: Number(row.pomo_credited ?? 0) === 1
  }
}

function eventRow(row: Record<string, unknown>): InterruptionEvent {
  return {
    id: String(row.id),
    sessionId: Number(row.session_id),
    taskId: (row.task_id as string) || null,
    type: row.type === 'external' ? 'external' : 'internal',
    note: String(row.note ?? ''),
    elapsedMs: Number(row.elapsed_ms ?? 0),
    createdAt: Number(row.created_at)
  }
}

function writeTasks(d: SqliteLike, tasks: Task[], mode: 'merge' | 'replace'): void {
  let existing = new Map<string, number>()
  if (mode === 'merge') {
    const rows = d.prepare('SELECT id, updated_at FROM tasks').all() as Array<{
      id: string
      updated_at: number
    }>
    existing = new Map(rows.map((r) => [r.id, Number(r.updated_at)]))
  }
  const stmt = d.prepare(
    `INSERT INTO tasks (id, title, priority, estimated_pomodoros, actual_pomodoros, status, sort_order, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       priority = excluded.priority,
       estimated_pomodoros = excluded.estimated_pomodoros,
       actual_pomodoros = excluded.actual_pomodoros,
       status = excluded.status,
       sort_order = excluded.sort_order,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`
  )
  for (const t of tasks) {
    if (mode === 'merge' && existing.has(t.id) && t.updatedAt < (existing.get(t.id) ?? 0)) continue
    const priority = PRIORITIES.has(t.priority) ? t.priority : 'medium'
    const status = TASK_STATUSES.has(t.status) ? t.status : 'todo'
    stmt.run(
      t.id,
      (t.title || '未命名任务').slice(0, 200),
      priority,
      clampEstimate(t.estimatedPomodoros),
      Math.max(0, Math.round(t.actualPomodoros || 0)),
      status,
      Math.round(t.sortOrder || 0),
      t.createdAt || Date.now(),
      t.updatedAt || Date.now(),
      t.completedAt
    )
  }
}

function writeFocusSessions(d: SqliteLike, sessions: FocusSessionBackup[]): void {
  const insert = d.prepare(
    `INSERT OR IGNORE INTO sessions (
       id, mode, level, started_at, duration_planned, duration_actual, pomos_completed,
       interruptions, status, ended_at, task_id, internal_interruptions, external_interruptions, pomo_credited
     ) VALUES (?, 'focus', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const s of sessions) {
    if (!s.id) continue
    insert.run(
      s.id,
      s.level || 'L0',
      s.startedAt || Date.now(),
      s.durationPlanned || 0,
      s.durationActual || 0,
      s.pomosCompleted || 0,
      s.interruptions || 0,
      s.status || 'done',
      s.endedAt,
      s.taskId,
      s.internalInterruptions || 0,
      s.externalInterruptions || 0,
      s.pomoCredited ? 1 : 0
    )
  }
}

function writeInterruptions(d: SqliteLike, events: InterruptionEvent[]): void {
  const stmt = d.prepare(
    `INSERT OR IGNORE INTO interruption_events (id, session_id, task_id, type, note, elapsed_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  for (const e of events) {
    if (!e.id || !e.sessionId) continue
    stmt.run(
      e.id,
      e.sessionId,
      e.taskId,
      e.type === 'external' ? 'external' : 'internal',
      (e.note || '').slice(0, 120),
      Math.max(0, Math.round(e.elapsedMs || 0)),
      e.createdAt || Date.now()
    )
  }
}
