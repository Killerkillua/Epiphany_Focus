import { useCallback, useEffect, useRef, useState } from 'react'
import { message } from 'antd'
import type { BiliContext, NoteEntry } from '../../../shared/bili'
import type { ChatMsg } from '../overlay/ChatPane'

/**
 * 共享笔记 hook（H-07/H-09/H-11 统一）。
 *
 * 视频学习助手的两处入口——悬浮面板（OverlayApp）与学习助手抽屉
 * （LearningAssistantDrawer）——过去各自实现一遍笔记逻辑（500ms 防抖自动保存 +
 * upsert 增量落库 + 草稿 flush + AI 回答入笔记 + 增删改/重点/时间点）。本 hook 抽出
 * 这份逻辑，两处共用。
 *
 * @param source 笔记来源（'overlay' = 悬浮面板 / 'main' = 抽屉，写入 NoteEntry.source）
 * @param getContext 读取当前学习上下文（须稳定引用，建议读自 ref）
 */
export interface UseNotesOptions {
  source: 'overlay' | 'main'
  getContext: () => BiliContext | null
}

export function useNotes({ source, getContext }: UseNotesOptions): {
  notes: NoteEntry[]
  noteDraft: string
  editingNoteId: string | null
  noteDirty: boolean
  loadNotes: (bvid?: string) => Promise<void>
  setDraft: (v: React.SetStateAction<string>) => void
  newNote: () => void
  selectNote: (entry: NoteEntry) => void
  deleteNote: (id: string) => Promise<void>
  toggleKey: (entry: NoteEntry) => void
  /** 把已落库的单条笔记合并进列表（AI 入笔记 / 落盘回调用） */
  addSavedNote: (saved: NoteEntry) => void
  /** I-4：AI 回答一键入笔记 */
  saveReplyToNotes: (msg: ChatMsg) => void
} {
  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [noteDraft, setNoteDraft] = useState('')
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteDirty, setNoteDirty] = useState(false)
  const persistTimer = useRef<number | null>(null)
  // 最新状态镜像：供异步闭包读取最新值（闭包里的 state 已过期）
  const ref = useRef({ notes, noteDraft, editingNoteId, noteDirty })
  ref.current = { notes, noteDraft, editingNoteId, noteDirty }

  /** 把已落库的单条笔记合并进列表（去重：存在则替换，否则置顶） */
  const addSavedNote = useCallback((saved: NoteEntry): void => {
    setNotes((prev) =>
      prev.some((n) => n.id === saved.id)
        ? prev.map((n) => (n.id === saved.id ? saved : n))
        : [saved, ...prev]
    )
  }, [])

  /** 载入笔记（bvid 为空载入全部）；切换视频前兜底 flush 未保存草稿 */
  const loadNotes = useCallback(
    async (bvid?: string): Promise<void> => {
      const prev = ref.current
      const ctx = getContext()
      // bvid 变化且存在未保存草稿：先按旧上下文落盘，避免切换视频丢弃用户输入
      if (prev.noteDirty && prev.noteDraft.trim() && ctx?.bvid !== bvid) {
        const flushingId = prev.editingNoteId || `n-${Date.now()}`
        const existing = prev.notes.find((n) => n.id === flushingId)
        void window.api.notes
          .upsert({
            id: flushingId,
            createdAt: existing?.createdAt ?? Date.now(),
            content: prev.noteDraft,
            bvid: ctx?.bvid,
            videoTitle: ctx?.videoTitle,
            source
          })
          .then((saved) => addSavedNote(saved))
          .catch(() => {
            /* 落盘失败不阻塞载入 */
          })
      }
      try {
        const list = bvid ? await window.api.notes.loadByVideo(bvid) : await window.api.notes.load()
        setNotes(list)
        // 聚焦最新一条笔记（若当前未在编辑）
        if (list.length > 0) {
          const latest = list[0]
          setEditingNoteId(latest.id)
          setNoteDraft(latest.content)
        } else {
          setEditingNoteId(null)
          setNoteDraft('')
        }
        setNoteDirty(false)
      } catch (err) {
        console.error('[notes] 载入笔记失败:', err)
      }
    },
    [getContext, source, addSavedNote]
  )

  /** 500ms 防抖增量自动保存（P-1，单条 upsert） */
  useEffect(() => {
    if (!noteDirty) return
    if (persistTimer.current) window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      const cur = ref.current
      const ctx = getContext()
      const id = cur.editingNoteId || `n-${Date.now()}`
      // 编辑既有笔记时复用原 createdAt（时间点/排序依据），仅新笔记取当前时间
      const existing = cur.notes.find((n) => n.id === id)
      const savedDraft = cur.noteDraft
      const entry: NoteEntry = {
        id,
        createdAt: existing?.createdAt ?? Date.now(),
        content: savedDraft,
        bvid: ctx?.bvid,
        videoTitle: ctx?.videoTitle,
        source
      }
      void window.api.notes
        .upsert(entry)
        .then((saved) => {
          // 收尾判断基于最新 state（本闭包里的 state 已过期）：
          // 请求期间用户继续输入（草稿已变）则保留新草稿与 dirty；否则回填并清 dirty
          const latest = ref.current
          const draftChanged = latest.noteDraft !== savedDraft
          addSavedNote(saved)
          setNoteDraft(draftChanged ? latest.noteDraft : saved.content)
          setNoteDirty(draftChanged ? latest.noteDirty : false)
          // 新笔记首次落盘（editingNoteId 为空）时挂接稳定 id
          setEditingNoteId((prev) => prev ?? saved.id)
        })
        .catch((err) => console.error('[notes] 笔记保存失败:', err))
    }, 500)
    return () => {
      if (persistTimer.current) window.clearTimeout(persistTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteDraft, noteDirty, editingNoteId])

  /** 新建笔记 */
  const newNote = useCallback((): void => {
    setEditingNoteId(`n-${Date.now()}`)
    setNoteDraft('')
    setNoteDirty(false)
  }, [])

  /** 用户编辑草稿：更新内容并标记 dirty（触发 500ms 防抖自动保存）。支持函数式更新（OCR 追加用） */
  const setDraft = useCallback((v: React.SetStateAction<string>): void => {
    setNoteDraft(v)
    setNoteDirty(true)
  }, [])

  /** 切换到另一条笔记：先落盘当前未保存的草稿，避免 500ms 防抖窗口内切换丢失 */
  const selectNote = useCallback(
    (entry: NoteEntry): void => {
      const cur = ref.current
      const ctx = getContext()
      if (cur.noteDirty && cur.noteDraft.trim()) {
        const flushingId = cur.editingNoteId || `n-${Date.now()}`
        // 复用既有笔记 createdAt，避免切换落盘把新笔记的创建时间重置为当前时刻
        const existing = cur.notes.find((n) => n.id === flushingId)
        void window.api.notes
          .upsert({
            id: flushingId,
            createdAt: existing?.createdAt ?? Date.now(),
            content: cur.noteDraft,
            bvid: ctx?.bvid,
            videoTitle: ctx?.videoTitle,
            source
          })
          .then((saved) => addSavedNote(saved))
          .catch(() => {
            /* 落盘失败不阻塞切换 */
          })
      }
      setEditingNoteId(entry.id)
      setNoteDraft(entry.content)
      setNoteDirty(false)
    },
    [getContext, source, addSavedNote]
  )

  /** 删除单条（返回 Promise：NotesPane 等落库结果后再提示成功/失败） */
  const deleteNote = useCallback((id: string): Promise<void> => {
    return window.api.notes.delete(id).then(() => {
      setNotes((prev) => prev.filter((n) => n.id !== id))
      if (ref.current.editingNoteId === id) {
        setEditingNoteId(`n-${Date.now()}`)
        setNoteDraft('')
        setNoteDirty(false)
      }
    })
  }, [])

  /** 重点标记（★ 只看重点过滤） */
  const toggleKey = useCallback(
    (entry: NoteEntry): void => {
      void window.api.notes
        .upsert({ ...entry, isKey: !entry.isKey })
        .then((saved) => addSavedNote(saved))
        .catch((err) =>
          message.error(`标记失败: ${err instanceof Error ? err.message : String(err)}`)
        )
    },
    [addSavedNote]
  )

  /** I-4：AI 回答一键存入笔记 */
  const saveReplyToNotes = useCallback(
    (msg: ChatMsg): void => {
      if (!msg.content.trim()) return
      const ctx = getContext()
      const entry: NoteEntry = {
        id: `ai-${Date.now()}`,
        createdAt: Date.now(),
        content: msg.content,
        bvid: ctx?.bvid,
        videoTitle: ctx?.videoTitle,
        source: 'ai'
      }
      void window.api.notes
        .upsert(entry)
        .then((saved) => {
          addSavedNote(saved)
          message.success('AI 回答已存入笔记（可到「笔记」页签查看）')
        })
        .catch((err) =>
          message.error(`存入笔记失败: ${err instanceof Error ? err.message : String(err)}`)
        )
    },
    [getContext, addSavedNote]
  )

  return {
    notes,
    noteDraft,
    editingNoteId,
    noteDirty,
    loadNotes,
    setDraft,
    newNote,
    selectNote,
    deleteNote,
    toggleKey,
    addSavedNote,
    saveReplyToNotes
  }
}
