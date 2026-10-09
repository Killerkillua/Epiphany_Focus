import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import type { BackupWorkerJob } from './backupWorker'
import { applyContentBackup, applyTaskBackup, assembleBackupFile } from './backupJob'
import { readBackupFile } from './backupParse'
import { openSqlite } from './sqliteOpen'
import { statSync, writeFileSync } from 'fs'

function workerScript(): string {
  return join(__dirname, 'backupWorker.js')
}

/** 在 Worker 中跑备份任务；开发/测试缺少产物时退回当前线程。 */
export function runBackupJob<T>(job: BackupWorkerJob): Promise<T> {
  const script = workerScript()
  if (!existsSync(script) || process.env.POMODORO_DB_DRIVER === 'node:sqlite') {
    return Promise.resolve(runInline(job) as T)
  }
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(script)
    const finish = (err?: Error, value?: T): void => {
      void worker.terminate()
      if (err) reject(err)
      else resolve(value as T)
    }
    worker.once('message', (msg: { ok: boolean; result?: T; error?: string }) => {
      if (!msg?.ok) finish(new Error(msg?.error || '备份任务失败'))
      else finish(undefined, msg.result)
    })
    worker.once('error', (err) => finish(err))
    worker.postMessage(job)
  })
}

function runInline(job: BackupWorkerJob): unknown {
  if (job.op === 'preview') {
    const backup = readBackupFile(job.filePath)
    return {
      exportedAt: backup.exportedAt,
      recordCount: backup.data.playRecords.length,
      noteCount: backup.data.notes.length,
      sessionCount: backup.data.studySessions.length,
      taskCount: backup.data.tasks?.length ?? 0
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
