import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { Task, TaskFilter, TaskPriority, TaskReview } from '../../shared/task'
import { num, oneOf, str } from '../validate'
import { getDb } from './db'
import { createTask, getTaskReview, listTasks, setTaskStatus, updateTask } from './taskRepository'

function requireDb(): void {
  if (!getDb()) throw new Error('本地数据库不可用，任务清单暂不可用')
}

const PRIORITIES = ['high', 'medium', 'low'] as const
const STATUSES = ['todo', 'done', 'archived'] as const
const SORTS = ['priority', 'created', 'remaining'] as const

export function registerTaskIpc(): void {
  ipcMain.handle(IPC_CHANNELS.tasks.list, (_event, filter: TaskFilter): Task[] => {
    requireDb()
    const f = filter ?? {}
    const status = oneOf(f.status, 'tasks.status', ['todo', 'done', 'archived', 'all'] as const, true)
    const sort = oneOf(f.sort, 'tasks.sort', SORTS, true)
    const keyword =
      f.keyword === undefined
        ? undefined
        : str(f.keyword, 'tasks.keyword', { max: 200, allowEmpty: true })
    return listTasks({ status, sort, keyword })
  })

  ipcMain.handle(IPC_CHANNELS.tasks.create, (_event, draft: { title?: string; priority?: string; estimatedPomodoros?: number }): Task => {
    requireDb()
    const title = str(draft?.title ?? '', 'tasks.title', { max: 200 })
    const priority = oneOf(draft?.priority, 'tasks.priority', PRIORITIES, true) as
      | TaskPriority
      | undefined
    const estimated =
      draft?.estimatedPomodoros === undefined
        ? undefined
        : num(draft.estimatedPomodoros, 'tasks.estimatedPomodoros')
    const task = createTask({ title, priority, estimatedPomodoros: estimated })
    if (!task) throw new Error('创建任务失败')
    return task
  })

  ipcMain.handle(
    IPC_CHANNELS.tasks.update,
    (
      _event,
      id: string,
      patch: { title?: string; priority?: string; estimatedPomodoros?: number }
    ): Task => {
      requireDb()
      const taskId = str(id ?? '', 'tasks.id', { max: 80 })
      const title =
        patch?.title === undefined
          ? undefined
          : str(patch.title, 'tasks.title', { max: 200 })
      const priority = oneOf(patch?.priority, 'tasks.priority', PRIORITIES, true) as
        | TaskPriority
        | undefined
      const estimated =
        patch?.estimatedPomodoros === undefined
          ? undefined
          : num(patch.estimatedPomodoros, 'tasks.estimatedPomodoros')
      const task = updateTask(taskId, { title, priority, estimatedPomodoros: estimated })
      if (!task) throw new Error('任务不存在')
      return task
    }
  )

  ipcMain.handle(IPC_CHANNELS.tasks.setStatus, (_event, id: string, status: string): Task => {
    requireDb()
    const taskId = str(id ?? '', 'tasks.id', { max: 80 })
    const next = oneOf(status, 'tasks.status', STATUSES)
    if (!next) throw new Error('任务状态无效')
    const task = setTaskStatus(taskId, next)
    if (!task) throw new Error('任务不存在')
    return task
  })

  ipcMain.handle(IPC_CHANNELS.tasks.review, (): TaskReview => {
    requireDb()
    return getTaskReview()
  })
}
