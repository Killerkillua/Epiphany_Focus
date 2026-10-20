import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Tag,
  message
} from 'antd'
import type { Task, TaskPriority, TaskSort, TaskStatus } from '../../../shared/task'

const PRIORITY_LABEL: Record<TaskPriority, string> = { high: '高', medium: '中', low: '低' }
const PRIORITY_COLOR: Record<TaskPriority, string> = { high: 'red', medium: 'orange', low: 'default' }

function TasksPage(): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [status, setStatus] = useState<TaskStatus>('todo')
  const [sort, setSort] = useState<TaskSort>('priority')
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [estimate, setEstimate] = useState(1)
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState<Task | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editPriority, setEditPriority] = useState<TaskPriority>('medium')
  const [editEstimate, setEditEstimate] = useState(1)

  const reload = (): void => setRevision((n) => n + 1)

  useEffect(() => {
    let alive = true
    void window.api.tasks
      .list({ status, sort })
      .then((list) => {
        if (alive) setTasks(list)
      })
      .catch((err: unknown) => {
        if (alive) message.error(err instanceof Error ? err.message : '加载任务失败')
      })
    return () => {
      alive = false
    }
  }, [status, sort, revision])

  const create = async (): Promise<void> => {
    const name = title.trim()
    if (!name) return
    try {
      await window.api.tasks.create({ title: name, priority, estimatedPomodoros: estimate })
      setTitle('')
      setEstimate(1)
      if (status !== 'todo') setStatus('todo')
      else reload()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '创建失败')
    }
  }

  const changeStatus = async (task: Task, next: TaskStatus): Promise<void> => {
    try {
      await window.api.tasks.setStatus(task.id, next)
      reload()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '更新失败')
    }
  }

  const openEdit = (task: Task): void => {
    setEditing(task)
    setEditTitle(task.title)
    setEditPriority(task.priority)
    setEditEstimate(task.estimatedPomodoros)
  }

  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    const name = editTitle.trim()
    if (!name) {
      message.warning('标题不能为空')
      return
    }
    try {
      await window.api.tasks.update(editing.id, {
        title: name,
        priority: editPriority,
        estimatedPomodoros: editEstimate
      })
      setEditing(null)
      reload()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '更新失败')
    }
  }

  const remove = async (task: Task): Promise<void> => {
    try {
      await window.api.tasks.delete(task.id)
      reload()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div>
      <h1 className="page-title">任务清单</h1>
      <p className="page-sub">计划今天要做的事，并为每项任务预估需要几个番茄。</p>

      <Card size="small" className="task-create">
        <Space wrap>
          <Input
            value={title}
            placeholder="新任务"
            maxLength={200}
            style={{ width: 280 }}
            onChange={(e) => setTitle(e.target.value)}
            onPressEnter={() => void create()}
          />
          <Select
            value={priority}
            style={{ width: 96 }}
            options={[
              { value: 'high', label: '高优先级' },
              { value: 'medium', label: '中优先级' },
              { value: 'low', label: '低优先级' }
            ]}
            onChange={setPriority}
          />
          <InputNumber
            min={1}
            max={48}
            value={estimate}
            addonAfter="番茄"
            onChange={(v) => v != null && setEstimate(v)}
          />
          <Button type="primary" onClick={() => void create()}>
            添加
          </Button>
        </Space>
      </Card>

      <div className="task-toolbar">
        <Segmented
          value={status}
          options={[
            { label: '待办', value: 'todo' },
            { label: '已完成', value: 'done' },
            { label: '归档', value: 'archived' }
          ]}
          onChange={(v) => setStatus(v as TaskStatus)}
        />
        <Select
          value={sort}
          style={{ width: 140 }}
          options={[
            { value: 'priority', label: '按优先级' },
            { value: 'created', label: '按创建时间' },
            { value: 'remaining', label: '按剩余番茄' }
          ]}
          onChange={setSort}
        />
      </div>

      {tasks.length === 0 ? (
        <Empty description="这个列表还是空的" />
      ) : (
        <div className="task-list">
          {tasks.map((task) => {
            const reached = task.actualPomodoros >= task.estimatedPomodoros
            return (
              <Card key={task.id} size="small" className="task-card">
                <div className="task-card-main">
                  <div>
                    <Tag color={PRIORITY_COLOR[task.priority]}>{PRIORITY_LABEL[task.priority]}</Tag>
                    <span className="task-title">{task.title}</span>
                    {reached && task.status === 'todo' && <Tag color="green">已达预估</Tag>}
                  </div>
                  <div className="task-pomo">
                    {task.actualPomodoros}/{task.estimatedPomodoros} 番茄
                  </div>
                </div>
                <Space wrap>
                  <Button size="small" onClick={() => openEdit(task)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除后不能恢复"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void remove(task)}
                  >
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                  {task.status === 'todo' && (
                    <Button size="small" type="primary" onClick={() => void changeStatus(task, 'done')}>
                      完成
                    </Button>
                  )}
                  {task.status === 'done' && (
                    <Button size="small" onClick={() => void changeStatus(task, 'todo')}>
                      重新打开
                    </Button>
                  )}
                  {task.status !== 'archived' && (
                    <Button size="small" onClick={() => void changeStatus(task, 'archived')}>
                      归档
                    </Button>
                  )}
                  {task.status === 'archived' && (
                    <Button size="small" onClick={() => void changeStatus(task, 'todo')}>
                      恢复为待办
                    </Button>
                  )}
                </Space>
              </Card>
            )
          })}
        </div>
      )}

      <Modal
        title="编辑任务"
        open={editing !== null}
        onOk={() => void saveEdit()}
        onCancel={() => setEditing(null)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input
            value={editTitle}
            maxLength={200}
            placeholder="任务标题"
            onChange={(e) => setEditTitle(e.target.value)}
            onPressEnter={() => void saveEdit()}
          />
          <Select
            value={editPriority}
            style={{ width: '100%' }}
            options={[
              { value: 'high', label: '高优先级' },
              { value: 'medium', label: '中优先级' },
              { value: 'low', label: '低优先级' }
            ]}
            onChange={setEditPriority}
          />
          <InputNumber
            min={1}
            max={48}
            value={editEstimate}
            addonAfter="预估番茄"
            style={{ width: '100%' }}
            onChange={(v) => v != null && setEditEstimate(v)}
          />
        </Space>
      </Modal>
    </div>
  )
}

export default TasksPage
