import { useEffect, useState } from 'react'
import { Input, InputNumber, Modal, Radio, Select } from 'antd'
import type { PlayRecord, PlayStatus } from '../../../../shared/stats'
import { useProgressStore } from '../../store/progressStore'
import { secondsToHMS, hmsToSeconds, STATUS_META } from './format'

interface ProgressEditDialogProps {
  /** 正在编辑的记录；null = 关闭 */
  record: PlayRecord | null
  onClose(): void
}

/** 时分秒数字输入（调整已观看时长 / 播放位置） */
function HMSInput({
  value,
  onChange,
  disabled
}: {
  value: { h: number; m: number; s: number }
  onChange(v: { h: number; m: number; s: number }): void
  disabled?: boolean
}): JSX.Element {
  const set = (k: 'h' | 'm' | 's', v: number | null): void => {
    onChange({ ...value, [k]: Math.max(0, Math.floor(v ?? 0)) })
  }
  return (
    <span className="progress-hms">
      <InputNumber
        size="small"
        min={0}
        max={99}
        value={value.h}
        onChange={(v) => set('h', v)}
        placeholder="时"
      />
      <span className="progress-hms-sep">:</span>
      <InputNumber
        size="small"
        min={0}
        max={59}
        value={value.m}
        onChange={(v) => set('m', v)}
        placeholder="分"
      />
      <span className="progress-hms-sep">:</span>
      <InputNumber
        size="small"
        min={0}
        max={59}
        value={value.s}
        onChange={(v) => set('s', v)}
        placeholder="秒"
      />
    </span>
  )
}

/**
 * 「调整进度」对话框（M1）：修改学习状态 / 已观看时长 / 上次播放位置 / 观看次数 /
 * 标签（antd Select mode=tags，可新建）/ 课程目标（精读遍数 + 截止日期）。
 */
function ProgressEditDialog({ record, onClose }: ProgressEditDialogProps): JSX.Element | null {
  const allTags = useProgressStore((s) => s.allTags)
  const updateRecord = useProgressStore((s) => s.updateRecord)
  const setTags = useProgressStore((s) => s.setTags)

  const [status, setStatus] = useState<PlayStatus>('planned')
  const [watched, setWatched] = useState({ h: 0, m: 0, s: 0 })
  const [position, setPosition] = useState({ h: 0, m: 0, s: 0 })
  const [viewedCount, setViewedCount] = useState(0)
  const [tags, setTagsLocal] = useState<string[]>([])
  const [goalRounds, setGoalRounds] = useState(0)
  const [goalDeadline, setGoalDeadline] = useState('')
  const [saving, setSaving] = useState(false)

  // 记录切换时同步表单
  useEffect(() => {
    if (!record) return
    setStatus(record.status)
    setWatched(secondsToHMS(record.watchedS))
    setPosition(secondsToHMS(record.lastPositionS))
    setViewedCount(record.viewedCount)
    setTagsLocal(record.tags)
    setGoalRounds(record.goalRounds)
    setGoalDeadline(record.goalDeadline)
  }, [record?.bvid]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!record) return null

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await updateRecord(record.bvid, {
        status,
        watchedS: hmsToSeconds(watched.h, watched.m, watched.s),
        lastPositionS: hmsToSeconds(position.h, position.m, position.s),
        viewedCount,
        goalRounds,
        goalDeadline
      })
      await setTags(record.bvid, tags)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="调整进度"
      open
      onOk={() => void handleSave()}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      width={400}
      centered
    >
      <div className="progress-edit-form">
        <div className="progress-edit-field">
          <span className="progress-edit-label">视频</span>
          <span className="progress-edit-title" title={record.title || record.bvid}>
            {record.title || record.bvid}
          </span>
        </div>
        <div className="progress-edit-field">
          <span className="progress-edit-label">学习状态</span>
          <Radio.Group
            value={status}
            onChange={(e) => setStatus(e.target.value as PlayStatus)}
            options={[
              { value: 'planned', label: STATUS_META.planned.label },
              { value: 'learning', label: STATUS_META.learning.label },
              { value: 'done', label: STATUS_META.done.label }
            ]}
            optionType="button"
            buttonStyle="solid"
            size="small"
          />
        </div>
        <div className="progress-edit-field">
          <span className="progress-edit-label">已观看时长</span>
          <HMSInput value={watched} onChange={setWatched} />
        </div>
        <div className="progress-edit-field">
          <span className="progress-edit-label">上次播放位置</span>
          <HMSInput value={position} onChange={setPosition} />
        </div>
        <div className="progress-edit-field">
          <span className="progress-edit-label">观看次数</span>
          <InputNumber
            size="small"
            min={0}
            max={99999}
            value={viewedCount}
            onChange={(v) => setViewedCount(v ?? 0)}
          />
        </div>
        <div className="progress-edit-field">
          <span className="progress-edit-label">标签</span>
          <Select
            size="small"
            mode="tags"
            placeholder="输入后回车添加"
            value={tags}
            onChange={(v: string[]) => setTagsLocal(v)}
            options={allTags.map((t) => ({ value: t, label: t }))}
            className="progress-edit-tags"
          />
        </div>
        <div className="progress-edit-field">
          <span className="progress-edit-label">目标遍数</span>
          <InputNumber
            size="small"
            min={0}
            max={99}
            value={goalRounds}
            onChange={(v) => setGoalRounds(v ?? 0)}
            addonAfter="遍"
          />
        </div>
        <div className="progress-edit-field">
          <span className="progress-edit-label">截止日期</span>
          <Input
            size="small"
            type="date"
            value={goalDeadline}
            onChange={(e) => setGoalDeadline(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  )
}

export default ProgressEditDialog
