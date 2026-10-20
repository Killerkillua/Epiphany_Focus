import { useEffect, useState } from 'react'
import { Modal, Radio, Typography, message } from 'antd'
import type { ImportPreview } from '../../../../shared/backup'

interface RestorePreviewModalProps {
  open: boolean
  preview: ImportPreview | null
  filePath: string
  onClose: () => void
}

/** M5 恢复预览 + 模式选择 + 二次确认弹窗 */
export default function RestorePreviewModal({
  open,
  preview,
  filePath,
  onClose
}: RestorePreviewModalProps): JSX.Element {
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge')
  const [restoring, setRestoring] = useState(false)

  // 每次打开恢复预览时重置为合并模式（与原实现 handleImportPreview 中 setRestoreMode('merge') 一致）
  useEffect(() => {
    if (open) setRestoreMode('merge')
  }, [open])

  const handleRestore = async (): Promise<void> => {
    if (!filePath) return
    setRestoring(true)
    try {
      const res = await window.api.playRecords.importData(filePath, restoreMode)
      if (res.ok) {
        message.success(
          `恢复完成：${res.records} 条记录、${res.notes} 条笔记、${res.sessions} 条会话${
            res.tasks ? `、${res.tasks} 条任务` : ''
          }${res.vocab ? `、${res.vocab} 条生词` : ''}`
        )
        onClose()
      } else {
        message.error(`恢复失败: ${res.error ?? '未知错误'}`)
      }
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Modal
      title="从备份恢复"
      open={open}
      onOk={() => void handleRestore()}
      onCancel={onClose}
      okText="确认恢复"
      cancelText="取消"
      confirmLoading={restoring}
      okButtonProps={{ danger: restoreMode === 'replace' }}
      width={420}
      centered
    >
      {preview && (
        <div className="restore-preview">
          <div className="restore-preview-line">
            备份时间：
            <span className="restore-preview-value">
              {new Date(preview.exportedAt).toLocaleString()}
            </span>
          </div>
          <div className="restore-preview-line">
            内容：
            <span className="restore-preview-value">
              {preview.recordCount} 条学习记录、{preview.noteCount} 条笔记、
              {preview.sessionCount} 条学习会话
              {preview.taskCount ? `、${preview.taskCount} 条任务` : ''}
              {preview.vocabCount ? `、${preview.vocabCount} 条生词` : ''}
            </span>
          </div>
          <div className="settings-row" style={{ marginTop: 10 }}>
            <span className="settings-label">恢复模式</span>
            <Radio.Group
              value={restoreMode}
              onChange={(e) => setRestoreMode(e.target.value as 'merge' | 'replace')}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio value="merge">合并（推荐）</Radio>
              <Radio value="replace">覆盖</Radio>
            </Radio.Group>
          </div>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, display: 'block', marginTop: 8 }}
          >
            {restoreMode === 'merge'
              ? '合并模式：与现有数据合并；同一课程取更新时间较新的记录，笔记按 id 保留现有；同词释义按字段合并（空不盖非空，都有则备份优先）。适用于跨设备同步 / 补充数据。'
              : '覆盖模式：将清空现有学习记录、标签、会话、笔记、任务与生词本，完全替换为备份内容。旧版备份若不含生词本，覆盖后本地生词也会被清空。此操作不可撤销！'}
          </Typography.Text>
        </div>
      )}
    </Modal>
  )
}
