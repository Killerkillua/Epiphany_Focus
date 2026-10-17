import type { Dispatch, SetStateAction } from 'react'
import { useState } from 'react'
import {
  Button,
  Card,
  Divider,
  Input,
  InputNumber,
  Select,
  Switch,
  Tag,
  Typography,
  message
} from 'antd'
import { CloudDownloadOutlined, CloudUploadOutlined, FolderOpenOutlined } from '@ant-design/icons'
import type { BackupMeta, ImportPreview } from '../../../../shared/backup'
import type { StatsExportFormat, VocabExportFormat } from '../../../../shared/export'
import RestorePreviewModal from './RestorePreviewModal'
import type { LocalForm, UpdateFn } from './types'

interface DataManagementCardProps {
  form: LocalForm
  setForm: Dispatch<SetStateAction<LocalForm>>
  saving: boolean
  update: UpdateFn
  /** M5 最近备份列表 */
  backups: BackupMeta[]
  /** 导出成功后刷新最近备份 */
  refreshBackups: () => Promise<void>
}

/** 📦 数据管理（M5：本地备份 / 恢复） */
export default function DataManagementCard({
  form,
  setForm,
  saving,
  update,
  backups,
  refreshBackups
}: DataManagementCardProps): JSX.Element {
  /** M5 恢复流程：预览 + 模式 + 二次确认 */
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restorePreview, setRestorePreview] = useState<ImportPreview | null>(null)
  const [restoreFilePath, setRestoreFilePath] = useState('')

  const handleExport = async (): Promise<void> => {
    try {
      const res = await window.api.playRecords.exportData()
      if (res.canceled) return
      if (res.ok && res.recordCount != null) {
        message.success(`备份成功，共 ${res.recordCount} 条学习记录`)
        await refreshBackups()
      } else {
        message.error(`备份失败: ${res.error ?? '未知错误'}`)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '备份失败')
    }
  }

  const handleImportPreview = async (): Promise<void> => {
    try {
      const res = await window.api.playRecords.importPreview()
      if (res.canceled) return
      if (res.ok && res.preview && res.filePath) {
        setRestorePreview(res.preview)
        setRestoreFilePath(res.filePath)
        setRestoreOpen(true)
      } else {
        message.error(`读取备份失败: ${res.error ?? '未知错误'}`)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '读取备份失败')
    }
  }

  const reportExport = async (
    task: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>,
    okText: string
  ): Promise<void> => {
    try {
      const res = await task()
      if (res.canceled) return
      if (res.ok) message.success(okText)
      else message.error(res.error ?? '导出失败')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '导出失败')
    }
  }

  const exportStats = (format: StatsExportFormat): Promise<void> =>
    reportExport(
      () => window.api.export.stats({ format }),
      format === 'csv' ? '已导出 CSV' : '已导出 Excel'
    )

  const exportNotes = (): Promise<void> =>
    reportExport(() => window.api.export.notesMarkdown(), '已导出全部笔记')

  const exportVocab = (format: VocabExportFormat): Promise<void> =>
    reportExport(
      () => window.api.export.vocab({ format }),
      format === 'apkg' ? '已导出 Anki 卡包' : '已导出 Anki 文本'
    )

  const handlePickBackupDir = async (): Promise<void> => {
    try {
      const dir = await window.api.settings.pickBackupDir()
      if (dir) {
        await update({ 'backup.directory': dir }, '备份目录已更新')
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '选择目录失败')
    }
  }

  return (
    <Card size="small" title="📦 数据管理（M5：本地备份 / 恢复）" className="settings-card">
      <div className="settings-row">
        <span className="settings-label">立即备份</span>
        <Button size="small" icon={<CloudUploadOutlined />} onClick={() => void handleExport()}>
          导出全部学习数据（JSON）
        </Button>
      </div>
      <div className="settings-row">
        <span className="settings-label">从备份恢复</span>
        <Button
          size="small"
          icon={<CloudDownloadOutlined />}
          onClick={() => void handleImportPreview()}
        >
          选择备份文件恢复
        </Button>
      </div>
      {backups.length > 0 && (
        <div className="backup-list">
          <div className="backup-list-title">最近备份：</div>
          {backups.map((b) => (
            <div key={b.id} className="backup-list-item">
              <Tag color={b.backupType === 'auto' ? 'blue' : 'green'}>
                {b.backupType === 'auto' ? '自动' : '手动'}
              </Tag>
              <span>{new Date(b.createdAt).toLocaleString()}</span>
              <span className="backup-list-meta">
                {b.recordCount} 条记录 · {(b.fileSize / 1024).toFixed(1)} KB
              </span>
            </div>
          ))}
        </div>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        JSON 备份含学习记录、笔记、会话、任务与生词本；Anki 仍是带走用。CSV、Excel、Markdown
        用于把其它数据带走。
      </Typography.Text>
      <div className="settings-row">
        <span className="settings-label">会话与番茄</span>
        <Button size="small" onClick={() => void exportStats('csv')}>
          导出 CSV
        </Button>
        <Button size="small" onClick={() => void exportStats('xlsx')}>
          导出 Excel
        </Button>
      </div>
      <div className="settings-row">
        <span className="settings-label">全部笔记</span>
        <Button size="small" onClick={() => void exportNotes()}>
          导出 Markdown 压缩包
        </Button>
      </div>
      <div className="settings-row">
        <span className="settings-label">生词本</span>
        <Button size="small" onClick={() => void exportVocab('apkg')}>
          导出 Anki 卡包
        </Button>
        <Button size="small" onClick={() => void exportVocab('txt')}>
          导出 Anki 文本
        </Button>
      </div>
      <Divider style={{ margin: '10px 0' }} />
      <div className="settings-row">
        <span className="settings-label">自动备份</span>
        <Switch
          checked={form.backupEnabled}
          disabled={saving}
          onChange={(v) =>
            void update({ 'backup.enabled': v }, v ? '已开启自动备份' : '已关闭自动备份')
          }
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">备份频率</span>
        <Select
          style={{ width: 140 }}
          size="small"
          value={form.backupFrequency}
          disabled={saving || !form.backupEnabled}
          options={[
            { value: 'daily', label: '每日' },
            { value: 'weekly', label: '每周（周日）' }
          ]}
          onChange={(v) => void update({ 'backup.frequency': v }, '备份频率已更新')}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">备份时间</span>
        <Input
          type="time"
          style={{ width: 120 }}
          size="small"
          value={form.backupTime}
          disabled={saving || !form.backupEnabled}
          onChange={(e) => setForm((f) => ({ ...f, backupTime: e.target.value }))}
          onBlur={(e) => {
            const t = e.target.value || '03:00'
            void update({ 'backup.time': t }, '备份时间已更新')
          }}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">保留份数</span>
        <InputNumber
          size="small"
          min={0}
          max={99}
          value={form.backupKeepCount}
          disabled={saving || !form.backupEnabled}
          onChange={(v) => void update({ 'backup.keepCount': Number(v ?? 7) }, '保留份数已更新')}
        />
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          （0 = 全部保留）
        </Typography.Text>
      </div>
      <div className="settings-row">
        <span className="settings-label">备份目录</span>
        <Input
          style={{ width: 240 }}
          size="small"
          value={form.backupDirectory || '默认（文档/静界专注备份）'}
          disabled
        />
        <Button
          size="small"
          icon={<FolderOpenOutlined />}
          onClick={() => void handlePickBackupDir()}
        >
          选择
        </Button>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        应用运行时到点自动备份；启动时若已过备份时刻且当天未备份则补备。备份失败不影响正常使用。
      </Typography.Text>

      <RestorePreviewModal
        open={restoreOpen}
        preview={restorePreview}
        filePath={restoreFilePath}
        onClose={() => setRestoreOpen(false)}
      />
    </Card>
  )
}
