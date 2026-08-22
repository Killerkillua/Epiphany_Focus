import { Button, Checkbox, Select } from 'antd'
import { CloseOutlined, DeleteOutlined } from '@ant-design/icons'
import type { PlayStatus } from '../../../../shared/stats'
import { useProgressStore } from '../../store/progressStore'
import { STATUS_META } from './format'

interface ProgressBatchBarProps {
  /** 批量删除确认（由容器弹 Modal） */
  onBatchDelete(): void
}

/**
 * 批量操作工具栏（M1）：全选当前列表 / 已选计数 / 批量改状态 / 批量删除 / 取消。
 * 批量改状态与删除完成后自动退出选择模式。
 */
function ProgressBatchBar({ onBatchDelete }: ProgressBatchBarProps): JSX.Element {
  const records = useProgressStore((s) => s.records)
  const selection = useProgressStore((s) => s.selection)
  const selectAll = useProgressStore((s) => s.selectAll)
  const setSelectMode = useProgressStore((s) => s.setSelectMode)
  const updateRecords = useProgressStore((s) => s.updateRecords)
  const markDone = useProgressStore((s) => s.markDone)

  const allSelected = records.length > 0 && records.every((r) => selection.includes(r.bvid))

  const handleBatchStatus = (status: PlayStatus): void => {
    if (selection.length === 0) return
    void updateRecords(selection, { status }).then(() => {
      setSelectMode(false)
    })
  }

  const handleMarkAllDone = (): void => {
    if (selection.length === 0) return
    // 批量"已学完"走单条 markDone（不覆盖其他字段），与单条操作语义一致
    void Promise.all(selection.map((bvid) => markDone(bvid))).then(() => setSelectMode(false))
  }

  return (
    <div className="progress-batch-bar">
      <Checkbox checked={allSelected} onChange={() => selectAll()}>
        全选
      </Checkbox>
      <span className="progress-batch-count">已选 {selection.length} 项</span>
      <Select<PlayStatus>
        size="small"
        placeholder="批量改状态"
        options={[
          { value: 'planned', label: `设为${STATUS_META.planned.label}` },
          { value: 'learning', label: `设为${STATUS_META.learning.label}` },
          { value: 'done', label: `设为${STATUS_META.done.label}` }
        ]}
        onChange={handleBatchStatus}
        style={{ width: 116 }}
      />
      <Button size="small" onClick={handleMarkAllDone} disabled={selection.length === 0}>
        全部学完
      </Button>
      <Button
        size="small"
        danger
        icon={<DeleteOutlined />}
        onClick={onBatchDelete}
        disabled={selection.length === 0}
      >
        删除
      </Button>
      <Button size="small" icon={<CloseOutlined />} onClick={() => setSelectMode(false)}>
        取消
      </Button>
    </div>
  )
}

export default ProgressBatchBar
