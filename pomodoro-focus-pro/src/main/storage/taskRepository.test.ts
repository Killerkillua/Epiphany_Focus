import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/electron-userData' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { closeDb, recordSessionEnd, recordSessionStart } from './db'
import { buildBackupFile, parseBackupFile } from './backup'
import {
  addInterruption,
  createTask,
  creditFocusPomodoro,
  exportTaskBackup,
  getTask,
  getTaskReview,
  importTaskBackup,
  listTasks
} from './taskRepository'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pomodoro-task-'))
  process.env.POMODORO_DB_PATH = join(dir, 'test.db')
  process.env.POMODORO_DB_DRIVER = 'node:sqlite'
  closeDb()
})

afterEach(() => {
  closeDb()
  delete process.env.POMODORO_DB_PATH
  delete process.env.POMODORO_DB_DRIVER
  rmSync(dir, { recursive: true, force: true })
})

describe('任务与番茄结算', () => {
  it('创建任务并按优先级列出', () => {
    createTask({ title: '低', priority: 'low', estimatedPomodoros: 2 })
    createTask({ title: '高', priority: 'high', estimatedPomodoros: 1 })
    expect(listTasks({ status: 'todo', sort: 'priority' }).map((t) => t.title)).toEqual(['高', '低'])
  })

  it('倒计时自然完成只给关联任务累加一次', () => {
    const task = createTask({ title: '写方案', priority: 'medium', estimatedPomodoros: 3 })
    const id = recordSessionStart({
      mode: 'focus',
      level: 'L1',
      startedAt: Date.now(),
      durationPlanned: 25 * 60_000,
      taskId: task!.id
    })
    expect(creditFocusPomodoro(id!, 25 * 60_000)).toBe(true)
    expect(creditFocusPomodoro(id!, 25 * 60_000)).toBe(false)
    expect(getTask(task!.id)?.actualPomodoros).toBe(1)
    recordSessionEnd(id!, {
      durationActual: 0,
      pomosCompleted: 0,
      interruptions: 0,
      status: 'abandoned'
    })
    const settled = getTask(task!.id)
    expect(settled?.actualPomodoros).toBe(1)
  })

  it('无任务专注可以结算，但不改任何任务计数', () => {
    const task = createTask({ title: '旁观', estimatedPomodoros: 1 })
    const id = recordSessionStart({
      mode: 'focus',
      level: 'L0',
      startedAt: Date.now(),
      durationPlanned: 25 * 60_000
    })
    expect(creditFocusPomodoro(id!, 25 * 60_000)).toBe(true)
    expect(getTask(task!.id)?.actualPomodoros).toBe(0)
  })

  it('打扰立即落库，并进入复盘', () => {
    const task = createTask({ title: '深度工作', estimatedPomodoros: 2 })
    const id = recordSessionStart({
      mode: 'focus',
      level: 'L1',
      startedAt: Date.now(),
      durationPlanned: 25 * 60_000,
      taskId: task!.id
    })
    addInterruption({
      sessionId: id!,
      taskId: task!.id,
      type: 'internal',
      note: '想查资料',
      elapsedMs: 12_000
    })
    addInterruption({
      sessionId: id!,
      taskId: task!.id,
      type: 'external',
      note: '',
      elapsedMs: 40_000
    })
    creditFocusPomodoro(id!, 25 * 60_000)
    const review = getTaskReview()
    expect(review.internalInterruptions).toBe(1)
    expect(review.externalInterruptions).toBe(1)
    expect(review.creditedPomodoros).toBe(1)
    expect(review.avgInterruptionsPerPomo).toBe(2)
    expect(review.topInterrupted[0]?.title).toBe('深度工作')
  })

  it('备份恢复任务、专注会话和打扰', () => {
    const task = createTask({ title: '可恢复', priority: 'high', estimatedPomodoros: 4 })
    const id = recordSessionStart({
      mode: 'focus',
      level: 'L0',
      startedAt: Date.now(),
      durationPlanned: 25 * 60_000,
      taskId: task!.id
    })
    addInterruption({
      sessionId: id!,
      taskId: task!.id,
      type: 'external',
      note: '电话',
      elapsedMs: 1000
    })
    creditFocusPomodoro(id!, 25 * 60_000)
    const file = parseBackupFile(JSON.stringify(buildBackupFile()))
    importTaskBackup(
      { tasks: [], focusSessions: [], interruptionEvents: [] },
      'replace'
    )
    expect(listTasks({ status: 'all' })).toHaveLength(0)
    importTaskBackup(
      {
        tasks: file.data.tasks ?? [],
        focusSessions: file.data.focusSessions ?? [],
        interruptionEvents: file.data.interruptionEvents ?? []
      },
      'merge'
    )
    expect(getTask(task!.id)?.actualPomodoros).toBe(1)
    expect(exportTaskBackup().interruptionEvents).toHaveLength(1)
  })
})
