import { Button, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { PlayRecord } from '../../../../shared/stats'
import { useProgressStore } from '../../store/progressStore'
import { resumeVideo } from '../../utils/resumeVideo'
import ProgressFilterBar from './ProgressFilterBar'
import ProgressBatchBar from './ProgressBatchBar'
import ProgressRecordCard from './ProgressRecordCard'

interface ProgressRecordListProps {
  /** 当前视频 bvid */
  bvid?: string
  /** 当前视频时间点跳转（当前视频续学时降级为 seek） */
  onSeek(seconds: number): void
  /** 打开「调整进度」对话框 */
  onEdit(rec: PlayRecord): void
  /** 删除确认（弹 Modal） */
  onDelete(rec: PlayRecord): void
  /** 批量删除确认（弹 Modal） */
  onBatchDelete(): void
}

/**
 * 记录列表区（M1/M2）：筛选栏 + 批量工具栏（选择模式）+ 卡片列表。
 * 续学：当前视频 → seek；其他 → resumeVideo 打开视频并跳转上次位置。
 */
function ProgressRecordList({
  bvid,
  onSeek,
  onEdit,
  onDelete,
  onBatchDelete
}: ProgressRecordListProps): JSX.Element {
  const records = useProgressStore((s) => s.records)
  const selectMode = useProgressStore((s) => s.selectMode)
  const selection = useProgressStore((s) => s.selection)
  const loading = useProgressStore((s) => s.loading)
  const load = useProgressStore((s) => s.load)
  const toggleSelect = useProgressStore((s) => s.toggleSelect)
  const markDone = useProgressStore((s) => s.markDone)

  const handleContinue = (rec: PlayRecord): void => {
    if (rec.bvid === bvid) {
      // 当前视频：直接跳转上次位置（含 0 → 从头播放），不重新打开窗口
      onSeek(rec.lastPositionS)
      return
    }
    void resumeVideo(rec).catch((err) =>
      message.error(`续学失败: ${err instanceof Error ? err.message : String(err)}`)
    )
  }

  return (
    <div className="progress-record-list">
      <div className="progress-list-toolbar">
        <ProgressFilterBar />
      </div>
      {selectMode && <ProgressBatchBar onBatchDelete={onBatchDelete} />}
      <div className="progress-list">
        {records.length === 0 ? (
          <div className="progress-empty">{loading ? '加载中…' : '没有匹配的学习记录'}</div>
        ) : (
          records.map((rec) => (
            <ProgressRecordCard
              key={rec.bvid}
              rec={rec}
              isCurrent={rec.bvid === bvid}
              selectMode={selectMode}
              selected={selection.includes(rec.bvid)}
              onToggleSelect={toggleSelect}
              onContinue={handleContinue}
              onEdit={onEdit}
              onDelete={onDelete}
              onMarkDone={(bv) => {
                void markDone(bv).then(() => message.success('已标记为学完'))
              }}
            />
          ))
        )}
      </div>
      <div className="progress-list-foot">
        <span className="progress-list-count">共 {records.length} 条</span>
        <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </div>
    </div>
  )
}

export default ProgressRecordList
