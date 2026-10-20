import { parentPort } from 'worker_threads'
import { statSync, writeFileSync } from 'fs'
import { applyContentBackup, applyTaskBackup, assembleBackupFile } from './backupJob'
import { readBackupFile } from './backupParse'
import { openSqlite } from './sqliteOpen'

export type BackupWorkerJob =
  | {
      op: 'export'
      dbPath: string
      filePath: string
      goals: { dailyMinutes: number; weeklyDays: number }
    }
  | { op: 'preview'; filePath: string }
  | { op: 'import'; dbPath: string; filePath: string; mode: 'merge' | 'replace' }

function run(job: BackupWorkerJob): unknown {
  if (job.op === 'preview') {
    const backup = readBackupFile(job.filePath)
    return {
      exportedAt: backup.exportedAt,
      recordCount: backup.data.playRecords.length,
      noteCount: backup.data.notes.length,
      sessionCount: backup.data.studySessions.length,
      taskCount: backup.data.tasks?.length ?? 0,
      vocabCount: backup.data.vocab?.length ?? 0
    }
  }
  if (job.op === 'export') {
    const db = openSqlite(job.dbPath, { readonly: true })
    try {
      const backup = assembleBackupFile(db, job.goals)
      writeFileSync(job.filePath, JSON.stringify(backup, null, 2), 'utf-8')
      return { recordCount: backup.data.playRecords.length, fileSize: statSync(job.filePath).size }
    } finally {
      db.close?.()
    }
  }
  const db = openSqlite(job.dbPath)
  try {
    const backup = readBackupFile(job.filePath)
    const content = applyContentBackup(db, backup.data, job.mode)
    const tasks = applyTaskBackup(
      db,
      {
        tasks: backup.data.tasks ?? [],
        focusSessions: backup.data.focusSessions ?? [],
        interruptionEvents: backup.data.interruptionEvents ?? []
      },
      job.mode
    )
    return { ...content, tasks: tasks.tasks }
  } finally {
    db.close?.()
  }
}

const port = parentPort
if (port) {
  port.on('message', (job: BackupWorkerJob) => {
    try {
      port.postMessage({ ok: true, result: run(job) })
    } catch (err) {
      port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
