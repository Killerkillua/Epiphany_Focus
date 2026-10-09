import { randomUUID } from 'crypto'
import type {
  FocusSessionBackup,
  InterruptionEvent,
  InterruptionType,
  Task,
  TaskDraft,
  TaskFilter,
  TaskPatch,
  TaskPriority,
  TaskReview,
  TaskSort,
  TaskStatus
} from '../../shared/task'
import { getDb, type SqliteLike } from './db'

const PRIORITIES = new Set<TaskPriority>(['high', 'medium', 'low'])
const STATUSES = new Set<TaskStatus>(['todo', 'done', 'archived'])

function clampEstimate(value: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 1
  return Math.min(48, Math.max(1, n))
}

function rowToTask(row: {
  id: string
  title: string
  priority: string
  estimated_pomodoros: number
  actual_pomodoros: number
  status: string
  sort_order: number
  created_at: number
  updated_at: number
  completed_at: number | null
}): Task {
  return {
    id: row.id,
    title: row.title,
    priority: PRIORITIES.has(row.priority as TaskPriority) ? (row.priority as TaskPriority) : 'medium',
    estimatedPomodoros: Number(row.estimated_pomodoros),
    actualPomodoros: Number(row.actual_pomodoros),
    status: STATUSES.has(row.status as TaskStatus) ? (row.status as TaskStatus) : 'todo',
    sortOrder: Number(row.sort_order),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at)
  }
}

export function createTask(draft: TaskDraft): Task | null {
  const d = getDb()
  const title = draft.title.trim()
  if (!d || !title) return null
  const now = Date.now()
  const id = randomUUID()
  const priority = PRIORITIES.has(draft.priority as TaskPriority)
    ? (draft.priority as TaskPriority)
    : 'medium'
  const estimate = clampEstimate(draft.estimatedPomodoros ?? 1)
  const maxRow = d.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM tasks').get() as {
    n: number
  }
  d.prepare(
    `INSERT INTO tasks (id, title, priority, estimated_pomodoros, actual_pomodoros, status, sort_order, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 0, 'todo', ?, ?, ?, NULL)`
  ).run(id, title.slice(0, 200), priority, estimate, Number(maxRow.n) + 1, now, now)
  return getTask(id)
}

export function getTask(id: string): Task | null {
  const d = getDb()
  if (!d || !id) return null
  const row = d.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | Parameters<typeof rowToTask>[0]
    | undefined
  return row ? rowToTask(row) : null
}

export function listTasks(filter: TaskFilter = {}): Task[] {
  const d = getDb()
  if (!d) return []
  const where: string[] = []
  const params: unknown[] = []
  const status = filter.status ?? 'todo'
  if (status === 'all') {
    where.push(`status != 'archived'`)
  } else if (STATUSES.has(status)) {
    where.push('status = ?')
    params.push(status)
  }
  const keyword = filter.keyword?.trim()
  if (keyword) {
    where.push('title LIKE ?')
    params.push(`%${keyword.slice(0, 200)}%`)
  }
  const sort: TaskSort = filter.sort ?? 'priority'
  const order =
    sort === 'created'
      ? 'created_at DESC'
      : sort === 'remaining'
        ? '(CASE WHEN estimated_pomodoros > actual_pomodoros THEN estimated_pomodoros - actual_pomodoros ELSE 0 END) ASC, created_at DESC'
        : `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC, created_at DESC`
  const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`
  const rows = d.prepare(sql).all(...params) as Array<Parameters<typeof rowToTask>[0]>
  return rows.map(rowToTask)
}

export function updateTask(id: string, patch: TaskPatch): Task | null {
  const d = getDb()
  if (!d || !id) return null
  const prev = getTask(id)
  if (!prev || prev.status === 'archived') return prev
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.title !== undefined) {
    const title = patch.title.trim().slice(0, 200)
    if (!title) return prev
    sets.push('title = ?')
    params.push(title)
  }
  if (patch.priority !== undefined && PRIORITIES.has(patch.priority)) {
    sets.push('priority = ?')
    params.push(patch.priority)
  }
  if (patch.estimatedPomodoros !== undefined) {
    sets.push('estimated_pomodoros = ?')
    params.push(clampEstimate(patch.estimatedPomodoros))
  }
  if (sets.length === 0) return prev
  sets.push('updated_at = ?')
  params.push(Date.now(), id)
  d.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getTask(id)
}

export function setTaskStatus(id: string, status: 'todo' | 'done' | 'archived'): Task | null {
  const d = getDb()
  if (!d || !id) return null
  const prev = getTask(id)
  if (!prev) return null
  const now = Date.now()
  const completedAt = status === 'done' ? now : null
  d.prepare(
    `UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`
  ).run(status, completedAt, now, id)
  return getTask(id)
}

/**
 * 倒计时自然完成时结算 1 个番茄。同一会话只生效一次。
 * 有关联任务时同步累加 actual_pomodoros。
 */
export function creditFocusPomodoro(sessionId: number, durationActual: number): boolean {
  const d = getDb()
  if (!d || !sessionId) return false
  d.prepare('BEGIN').run()
  try {
    const row = d
      .prepare(`SELECT task_id, mode FROM sessions WHERE id = ?`)
      .get(sessionId) as { task_id: string | null; mode: string } | undefined
    if (!row || row.mode !== 'focus') {
      d.prepare('COMMIT').run()
      return false
    }
    const now = Date.now()
    const info = d
      .prepare(
        `UPDATE sessions
         SET duration_actual = ?,
             pomos_completed = 1,
             status = 'done',
             ended_at = ?,
             pomo_credited = 1,
             interruptions = internal_interruptions + external_interruptions
         WHERE id = ? AND pomo_credited = 0`
      )
      .run(Math.max(0, Math.round(durationActual)), now, sessionId)
    if ((info.changes ?? 0) < 1) {
      d.prepare('COMMIT').run()
      return false
    }
    if (row.task_id) {
      d.prepare(
        `UPDATE tasks SET actual_pomodoros = actual_pomodoros + 1, updated_at = ? WHERE id = ?`
      ).run(now, row.task_id)
    }
    d.prepare('COMMIT').run()
    return true
  } catch (err) {
    try {
      d.prepare('ROLLBACK').run()
    } catch {
      // 连接级异常时保留原始错误
    }
    throw err
  }
}

export function getFocusSessionContext(sessionId: number): {
  taskId: string | null
  taskTitle: string | null
  internalInterruptions: number
  externalInterruptions: number
} | null {
  const d = getDb()
  if (!d || !sessionId) return null
  const row = d
    .prepare(
      `SELECT s.task_id, s.internal_interruptions, s.external_interruptions, t.title AS task_title
       FROM sessions s LEFT JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`
    )
    .get(sessionId) as
    | {
        task_id: string | null
        task_title: string | null
        internal_interruptions: number
        external_interruptions: number
      }
    | undefined
  if (!row) return null
  return {
    taskId: row.task_id || null,
    taskTitle: row.task_title || null,
    internalInterruptions: Number(row.internal_interruptions ?? 0),
    externalInterruptions: Number(row.external_interruptions ?? 0)
  }
}

export function addInterruption(input: {
  sessionId: number
  taskId: string | null
  type: InterruptionType
  note: string
  elapsedMs: number
}): InterruptionEvent | null {
  const d = getDb()
  if (!d || !input.sessionId) return null
  const now = Date.now()
  const id = randomUUID()
  const note = input.note.trim().slice(0, 120)
  const elapsed = Math.max(0, Math.round(input.elapsedMs))
  const column = input.type === 'internal' ? 'internal_interruptions' : 'external_interruptions'
  d.prepare('BEGIN').run()
  try {
    d.prepare(
      `INSERT INTO interruption_events (id, session_id, task_id, type, note, elapsed_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.sessionId, input.taskId, input.type, note, elapsed, now)
    d.prepare(
      `UPDATE sessions
       SET ${column} = ${column} + 1,
           interruptions = internal_interruptions + external_interruptions + 1
       WHERE id = ?`
    ).run(input.sessionId)
    d.prepare('COMMIT').run()
  } catch (err) {
    try {
      d.prepare('ROLLBACK').run()
    } catch {
      // 忽略回滚失败
    }
    throw err
  }
  return {
    id,
    sessionId: input.sessionId,
    taskId: input.taskId,
    type: input.type,
    note,
    elapsedMs: elapsed,
    createdAt: now
  }
}

export function updateInterruptionNote(
  id: string,
  sessionId: number,
  note: string
): boolean {
  const d = getDb()
  if (!d || !id || !sessionId) return false
  const info = d
    .prepare(`UPDATE interruption_events SET note = ? WHERE id = ? AND session_id = ?`)
    .run(note.trim().slice(0, 120), id, sessionId)
  return (info.changes ?? 0) > 0
}

export function getTaskReview(): TaskReview {
  const d = getDb()
  const empty: TaskReview = {
    todayDone: 0,
    todoCount: 0,
    estimatedOpen: 0,
    actualOpen: 0,
    internalInterruptions: 0,
    externalInterruptions: 0,
    creditedPomodoros: 0,
    avgInterruptionsPerPomo: null,
    quality: null,
    topInterrupted: []
  }
  if (!d) return empty
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const doneRow = d
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks WHERE status = 'done' AND completed_at >= ?`
    )
    .get(start.getTime()) as { c: number }
  const openRow = d
    .prepare(
      `SELECT COUNT(*) AS c,
              COALESCE(SUM(estimated_pomodoros), 0) AS estimated,
              COALESCE(SUM(actual_pomodoros), 0) AS actual
       FROM tasks WHERE status = 'todo'`
    )
    .get() as { c: number; estimated: number; actual: number }
  const pomoRow = d
    .prepare(
      `SELECT COUNT(*) AS pomos,
              COALESCE(SUM(internal_interruptions), 0) AS internal,
              COALESCE(SUM(external_interruptions), 0) AS external
       FROM sessions WHERE mode = 'focus' AND pomo_credited = 1`
    )
    .get() as { pomos: number; internal: number; external: number }
  const pomos = Number(pomoRow.pomos)
  const interruptions = Number(pomoRow.internal) + Number(pomoRow.external)
  const avg = pomos > 0 ? Math.round((interruptions / pomos) * 10) / 10 : null
  const top = d
    .prepare(
      `SELECT t.id AS taskId, t.title AS title,
              COALESCE(SUM(s.internal_interruptions + s.external_interruptions), 0) AS interruptions,
              COALESCE(SUM(s.pomos_completed), 0) AS pomos
       FROM tasks t
       JOIN sessions s ON s.task_id = t.id AND s.mode = 'focus' AND s.pomo_credited = 1
       GROUP BY t.id
       HAVING interruptions > 0
       ORDER BY interruptions DESC
       LIMIT 5`
    )
    .all() as Array<{ taskId: string; title: string; interruptions: number; pomos: number }>
  return {
    todayDone: Number(doneRow.c),
    todoCount: Number(openRow.c),
    estimatedOpen: Number(openRow.estimated),
    actualOpen: Number(openRow.actual),
    internalInterruptions: Number(pomoRow.internal),
    externalInterruptions: Number(pomoRow.external),
    creditedPomodoros: pomos,
    avgInterruptionsPerPomo: avg,
    quality: avg == null ? null : Math.round((1 / (1 + avg)) * 100) / 100,
    topInterrupted: top.map((r) => ({
      taskId: r.taskId,
      title: r.title,
      interruptions: Number(r.interruptions),
      pomos: Number(r.pomos)
    }))
  }
}

export function listTasksForBackup(): Task[] {
  const d = getDb()
  if (!d) return []
  const rows = d.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as Array<
    Parameters<typeof rowToTask>[0]
  >
  return rows.map(rowToTask)
}

export function listFocusSessionsForBackup(): FocusSessionBackup[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT id, task_id, level, started_at, ended_at, duration_planned, duration_actual,
              pomos_completed, interruptions, internal_interruptions, external_interruptions,
              status, pomo_credited
       FROM sessions WHERE mode = 'focus' ORDER BY started_at ASC`
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    taskId: (r.task_id as string) || null,
    level: String(r.level ?? 'L0'),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    durationPlanned: Number(r.duration_planned ?? 0),
    durationActual: Number(r.duration_actual ?? 0),
    pomosCompleted: Number(r.pomos_completed ?? 0),
    interruptions: Number(r.interruptions ?? 0),
    internalInterruptions: Number(r.internal_interruptions ?? 0),
    externalInterruptions: Number(r.external_interruptions ?? 0),
    status: String(r.status ?? 'done'),
    pomoCredited: Number(r.pomo_credited ?? 0) === 1
  }))
}

export function listInterruptionsForBackup(): InterruptionEvent[] {
  const d = getDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT id, session_id, task_id, type, note, elapsed_ms, created_at
       FROM interruption_events ORDER BY created_at ASC`
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: String(r.id),
    sessionId: Number(r.session_id),
    taskId: (r.task_id as string) || null,
    type: r.type === 'external' ? 'external' : 'internal',
    note: String(r.note ?? ''),
    elapsedMs: Number(r.elapsed_ms ?? 0),
    createdAt: Number(r.created_at)
  }))
}

export interface TaskBackupSlice {
  tasks: Task[]
  focusSessions: FocusSessionBackup[]
  interruptionEvents: InterruptionEvent[]
}

export function exportTaskBackup(): TaskBackupSlice {
  return {
    tasks: listTasksForBackup(),
    focusSessions: listFocusSessionsForBackup(),
    interruptionEvents: listInterruptionsForBackup()
  }
}

/** 恢复任务、专注会话与打扰。调用方需已清洗字段。独立事务，不嵌套进其他 BEGIN。 */
export function importTaskBackup(
  data: TaskBackupSlice,
  mode: 'merge' | 'replace'
): { tasks: number; focusSessions: number; interruptions: number } {
  const d = getDb()
  const result = { tasks: 0, focusSessions: 0, interruptions: 0 }
  if (!d) return result
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const sessions = Array.isArray(data.focusSessions) ? data.focusSessions : []
  const events = Array.isArray(data.interruptionEvents) ? data.interruptionEvents : []
  d.prepare('BEGIN').run()
  try {
    if (mode === 'replace') {
      d.prepare(`DELETE FROM interruption_events`).run()
      d.prepare(`DELETE FROM sessions WHERE mode = 'focus'`).run()
      d.prepare(`DELETE FROM tasks`).run()
    }
    writeTasks(d, tasks, mode)
    result.tasks = tasks.length
    writeFocusSessions(d, sessions, mode)
    result.focusSessions = sessions.length
    writeInterruptions(d, events)
    result.interruptions = events.length
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
    const status = STATUSES.has(t.status) ? t.status : 'todo'
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

function writeFocusSessions(
  d: SqliteLike,
  sessions: FocusSessionBackup[],
  mode: 'merge' | 'replace'
): void {
  const insert = d.prepare(
    `INSERT OR IGNORE INTO sessions (
       id, mode, level, started_at, duration_planned, duration_actual, pomos_completed,
       interruptions, status, ended_at, task_id, internal_interruptions, external_interruptions, pomo_credited
     ) VALUES (?, 'focus', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const s of sessions) {
    if (!s.id) continue
    if (mode === 'merge') {
      const prev = d.prepare('SELECT id FROM sessions WHERE id = ?').get(s.id)
      if (prev) continue
    }
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
    const session = d.prepare('SELECT id FROM sessions WHERE id = ?').get(e.sessionId)
    if (!session) continue
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
