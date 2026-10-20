import type { SqliteLike } from './sqliteOpen'

const BACKFILL_SQL = `
INSERT INTO heatmap_cells (weekday, hour, minutes, sessions)
SELECT
  CAST(strftime('%w', datetime(started_at / 1000, 'unixepoch', 'localtime')) AS INTEGER),
  CAST(strftime('%H', datetime(started_at / 1000, 'unixepoch', 'localtime')) AS INTEGER),
  CAST(SUM(duration_actual) AS REAL) / 60000.0,
  COUNT(*)
FROM sessions
WHERE status = 'done' AND ended_at IS NOT NULL
GROUP BY 1, 2
`

/** 用已完成会话重算热力图（导入专注会话后调用） */
export function rebuildHeatmap(d: SqliteLike): void {
  d.exec('DELETE FROM heatmap_cells')
  d.exec(BACKFILL_SQL)
}

/** 表为空时用历史会话回填一次；之后只靠写入时累加 */
export function backfillHeatmapIfEmpty(d: SqliteLike): void {
  const row = d.prepare('SELECT COUNT(*) AS c FROM heatmap_cells').get() as { c: number } | undefined
  if (Number(row?.c ?? 0) > 0) return
  d.exec(BACKFILL_SQL)
}

/** 一次完成的专注/学习会话累加到星期×小时格子 */
export function addSessionToHeatmap(
  d: SqliteLike,
  startedAt: number,
  durationActualMs: number
): void {
  if (!Number.isFinite(startedAt)) return
  const when = new Date(startedAt)
  const minutes = Math.round((Math.max(0, durationActualMs) / 60_000) * 10) / 10
  d.prepare(
    `INSERT INTO heatmap_cells (weekday, hour, minutes, sessions)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(weekday, hour) DO UPDATE SET
       minutes = minutes + excluded.minutes,
       sessions = sessions + 1`
  ).run(when.getDay(), when.getHours(), minutes)
}
