import { Button, Empty, Input, Tooltip, message } from 'antd'
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileImageOutlined,
  PlusOutlined,
  StarFilled,
  StarOutlined
} from '@ant-design/icons'
import type { BiliContext, NoteEntry } from '../../../shared/bili'
import { formatSeconds } from './ProgressRing'

interface NotesPaneProps {
  notes: NoteEntry[]
  draft: string
  editingId: string | null
  context: BiliContext | null
  onDraftChange(value: string): void
  onNewNote(): void
  onSelectNote(entry: NoteEntry): void
  onDeleteNote(id: string): void
  onToggleKey(entry: NoteEntry): void
  /** F-2 时间点标记：记录当前播放位置为重点 */
  onMarkKeyPoint(): void
  /** F-2 时间点跳转：从进度/笔记点击重点跳到视频对应位置 */
  onSeek(seconds: number): void
  /** 非视频模式扩展（学习助手抽屉）：导出当前笔记为 Markdown */
  onExport?: () => void
  /** 非视频模式扩展（学习助手抽屉）：图片 OCR 识别（父组件负责文件选择/粘贴） */
  onOcr?: () => void
  /** OCR 进行中（按钮 loading 态） */
  ocrBusy?: boolean
}

/**
 * 笔记页签（I-1）：全高编辑区 + 按视频归档的笔记列表（F-1）；
 * 重点标记 is_key（F-2）+ 时间点标记/跳转（F-2）。
 */
function NotesPane({
  notes,
  draft,
  editingId,
  context,
  onDraftChange,
  onNewNote,
  onSelectNote,
  onDeleteNote,
  onToggleKey,
  onMarkKeyPoint,
  onSeek,
  onExport,
  onOcr,
  ocrBusy = false
}: NotesPaneProps): JSX.Element {
  const hasBvid = Boolean(context?.bvid)

  const handleDelete = (entry: NoteEntry): void => {
    onDeleteNote(entry.id)
    message.success('笔记已删除')
  }

  return (
    <div className="overlay-pane overlay-notes-pane">
      <div className="overlay-notes-toolbar">
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={onNewNote}>
          新建
        </Button>
        <Tooltip title={hasBvid ? '记录当前视频时间点为重点，可随时跳回' : '需先打开视频才能记录时间点'}>
          <Button size="small" icon={<StarFilled />} disabled={!hasBvid} onClick={onMarkKeyPoint}>
            记重点
          </Button>
        </Tooltip>
        {onExport && (
          <Button size="small" icon={<DownloadOutlined />} onClick={onExport}>
            导出
          </Button>
        )}
        {onOcr && (
          <Button size="small" icon={<FileImageOutlined />} loading={ocrBusy} onClick={onOcr}>
            OCR
          </Button>
        )}
        <span className="overlay-autosave">500ms 自动保存</span>
      </div>

      <div className="overlay-notes-list">
        {notes.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无笔记，先记一条吧" />
        ) : (
          notes.map((entry) => (
            <div
              key={entry.id}
              className={`overlay-note-item${entry.id === editingId ? ' active' : ''}${
                entry.isKey ? ' is-key' : ''
              }`}
              onClick={() => onSelectNote(entry)}
            >
              <div className="overlay-note-item-main">
                <Tooltip title={entry.isKey ? '取消重点标记' : '标记为重点'}>
                  <Button
                    type="text"
                    size="small"
                    className="overlay-note-star"
                    icon={entry.isKey ? <StarFilled style={{ color: 'var(--brand, #ff6b4a)' }} /> : <StarOutlined />}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onToggleKey(entry)
                    }}
                  />
                </Tooltip>
                <span className="overlay-note-preview">
                  {entry.content.split('\n')[0] || '（空笔记）'}
                </span>
                {entry.timestampS !== undefined && entry.timestampS > 0 && (
                  <Tooltip title="跳转到该时间点">
                    <Button
                      type="text"
                      size="small"
                      className="overlay-note-time"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        onSeek(entry.timestampS ?? 0)
                      }}
                    >
                      ⏱ {formatSeconds(entry.timestampS)}
                    </Button>
                  </Tooltip>
                )}
                <Tooltip title="删除">
                  <Button
                    type="text"
                    size="small"
                    className="overlay-note-delete"
                    icon={<DeleteOutlined />}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      handleDelete(entry)
                    }}
                  />
                </Tooltip>
              </div>
              <div className="overlay-note-meta">
                {new Date(entry.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
                {entry.isKey && <span className="overlay-note-key-badge">★ 重点</span>}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="overlay-notes-editor-wrap">
        <div className="overlay-section-title">
          <EditOutlined /> {editingId ? '编辑笔记' : '新笔记'}
        </div>
        <Input.TextArea
          className="overlay-notes-input"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="随时记录要点 / 疑问 / 灵感…"
          autoFocus={false}
        />
      </div>
    </div>
  )
}

export default NotesPane
