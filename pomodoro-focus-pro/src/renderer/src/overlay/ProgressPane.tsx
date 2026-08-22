import { useEffect, useState } from 'react'
import { Modal, message } from 'antd'
import type { PlayRecord } from '../../../shared/stats'
import { useProgressStore } from '../store/progressStore'
import ProgressOverview from '../components/progress/ProgressOverview'
import ProgressCharts from '../components/progress/ProgressCharts'
import ProgressRecordList from '../components/progress/ProgressRecordList'
import ProgressEditDialog from '../components/progress/ProgressEditDialog'

interface ProgressPaneProps {
  /** 当前视频 bvid（决定"当前视频"高亮与续学/标记快捷操作；无视频时 undefined） */
  bvid?: string
  /** 当前视频时间点跳转（续学降级 / 重点回跳共用） */
  onSeek(seconds: number): void
}

/**
 * 进度页签（M1 记录管理 + M2 快捷访问 + M3 进度追踪增强）。
 * 悬浮面板（610px）与学习助手抽屉（420px）共享；数据由 progressStore 统一管理，
 * 会话心跳 tick 由宿主（OverlayApp）落库后经 store.applyTick 推送本地即时更新。
 *
 * 布局：列表区（筛选栏 + 批量栏 + 记录卡片）→ 概览区（统计 + 全局目标 + 继续学习）→ 图表区。
 * 整个面板单一滚动条，避免狭小容器（420px 抽屉）中子区域争抢空间导致内容截断。
 */
function ProgressPane({ bvid, onSeek }: ProgressPaneProps): JSX.Element {
  const load = useProgressStore((s) => s.load)
  const removeRecords = useProgressStore((s) => s.removeRecords)
  const selection = useProgressStore((s) => s.selection)
  const setSelectMode = useProgressStore((s) => s.setSelectMode)

  const [editing, setEditing] = useState<PlayRecord | null>(null)
  const [deleting, setDeleting] = useState<PlayRecord | null>(null)
  const [batchDeleting, setBatchDeleting] = useState(false)

  // 挂载 / 当前视频切换时加载（列表 + 统计 + 标签；两个入口复用同一 store）
  useEffect(() => {
    void load()
  }, [bvid, load])

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    try {
      await removeRecords([deleting.bvid])
      setDeleting(null)
      message.success('已删除')
    } catch (err) {
      message.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const confirmBatchDelete = async (): Promise<void> => {
    try {
      await removeRecords(selection)
      setSelectMode(false)
      setBatchDeleting(false)
      message.success(`已删除 ${selection.length} 条记录`)
    } catch (err) {
      message.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="overlay-pane progress-pane">
      <ProgressRecordList
        bvid={bvid}
        onSeek={onSeek}
        onEdit={setEditing}
        onDelete={setDeleting}
        onBatchDelete={() => setBatchDeleting(true)}
      />
      <ProgressOverview bvid={bvid} onSeek={onSeek} />
      <ProgressCharts />

      <ProgressEditDialog record={editing} onClose={() => setEditing(null)} />

      {/* 单条删除确认（M1）：提示不可恢复 + 笔记保留（决策：不级联删笔记） */}
      <Modal
        title="删除学习记录"
        open={deleting !== null}
        onOk={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        width={380}
        centered
      >
        {deleting && (
          <div>
            确定删除《{deleting.title || deleting.bvid}》的学习记录吗？此操作不可恢复。
            <div className="progress-delete-hint">该视频的笔记将保留。</div>
          </div>
        )}
      </Modal>

      {/* 批量删除确认（M1） */}
      <Modal
        title="批量删除"
        open={batchDeleting}
        onOk={() => void confirmBatchDelete()}
        onCancel={() => setBatchDeleting(false)}
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        width={380}
        centered
      >
        <div>
          确定删除选中的 {selection.length} 条学习记录吗？此操作不可恢复。
          <div className="progress-delete-hint">相关笔记将保留。</div>
        </div>
      </Modal>
    </div>
  )
}

export default ProgressPane
