import { useEffect, useState } from 'react'
import { Button, Input, InputNumber, Select, Space, message } from 'antd'
import type { Task, TaskPriority } from '../../../shared/task'

interface Props {
  value: string | null
  disabled?: boolean
  /** 正序专注只记录时长，不增加已消耗番茄 */
  countsPomodoro?: boolean
  onChange: (taskId: string | null) => void
}

const PRIORITY_OPTIONS: Array<{ value: TaskPriority; label: string }> = [
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' }
]

/** 启动专注前选择未完成任务，并支持快速新建。 */
function TaskSelect({ value, disabled, countsPomodoro = true, onChange }: Props): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [estimate, setEstimate] = useState(1)

  const load = async (): Promise<void> => {
    const list = await window.api.tasks.list({ status: 'todo', sort: 'priority' })
    setTasks(list)
  }

  useEffect(() => {
    void load().catch(() => {
      setTasks([])
    })
  }, [])

  const create = async (): Promise<void> => {
    const name = title.trim()
    if (!name) return
    try {
      const task = await window.api.tasks.create({
        title: name,
        priority,
        estimatedPomodoros: estimate
      })
      setTitle('')
      setCreating(false)
      await load()
      onChange(task.id)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '创建任务失败')
    }
  }

  return (
    <div className="task-select">
      <Select
        allowClear
        showSearch
        disabled={disabled}
        style={{ width: '100%' }}
        placeholder="选择当前任务（可不选）"
        value={value ?? undefined}
        optionFilterProp="label"
        options={tasks.map((t) => ({
          value: t.id,
          label: `${t.title} · ${t.actualPomodoros}/${t.estimatedPomodoros}`
        }))}
        onChange={(id) => onChange(id ?? null)}
      />
      {!disabled && !creating && (
        <Button type="link" size="small" onClick={() => setCreating(true)}>
          快速新建
        </Button>
      )}
      {!disabled && creating && (
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={title}
            placeholder="任务标题"
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            onPressEnter={() => void create()}
          />
          <Select
            value={priority}
            style={{ width: 72 }}
            options={PRIORITY_OPTIONS}
            onChange={setPriority}
          />
          <InputNumber min={1} max={48} value={estimate} onChange={(v) => v != null && setEstimate(v)} />
          <Button type="primary" onClick={() => void create()}>
            添加
          </Button>
          <Button onClick={() => setCreating(false)}>取消</Button>
        </Space.Compact>
      )}
      <div className="task-select-hint">
        {value
          ? countsPomodoro
            ? '本轮倒计时完成后会计入该任务'
            : '正序专注会记下任务，但不增加已消耗番茄'
          : '未选择任务，本次专注不计入待办'}
      </div>
    </div>
  )
}

export default TaskSelect
