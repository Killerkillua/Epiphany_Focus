import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc'
import { searchBiliVideo } from './biliSearch'
import { warmupWbiCache, resetWbiCache } from './wbi'
import { warmupFingerprint } from './biliFingerprint'
import { isAllowedBiliUrl } from './guard'
import { getSettings } from '../storage/settings'
import { buildBackupFile, readBackupFile, writeBackupFile } from '../storage/backup'
import { importTaskBackup } from '../storage/taskRepository'
import { assertExitSafety } from '../enforcement/emergencyExit'
import { recordTelemetry } from '../telemetry'
import {
  closeVideo,
  ensureOverlayOnTop,
  getContext,
  getOverlaySnapshot,
  getOverlayWindow,
  getVideoDuration,
  getVideoPosition,
  getVideoState,
  markRelevant,
  openVideo,
  registerVideoEvents,
  resizeOverlay,
  seekTo,
  setOverlayState,
  toggleOverlayHide
} from './biliWindow'
import {
  addFeedback,
  batchDeletePlayRecords,
  batchUpdatePlayRecords,
  deleteNote,
  deletePlayRecord,
  getAllPlayRecordTags,
  getDailyStudyMinutes,
  getFeedbackStats,
  getPlayRecord,
  getProgressStats,
  getStudySessionsByVideo,
  importBackupData,
  listBackupMeta,
  listFeedback,
  listPlayRecords,
  loadNotesAll,
  loadNotesByVideo,
  markPlayRecordDone,
  saveNotesAll,
  searchPlayRecords,
  setPlayGoal,
  setPlayRecordTags,
  tickPlayRecord,
  updatePlayRecord,
  upsertNote,
  upsertPlayRecord
} from '../storage/db'
import type { EnforcementHandle } from '../enforcement'
import type { SessionHandle } from '../session'
import type {
  BiliSearchOptions,
  BiliSearchResponse,
  BiliContext,
  NavVerdict,
  OpenVideoPayload,
  OverlaySize,
  OverlaySnapshot,
  OverlayState,
  VideoState,
  NoteEntry,
  MarkRelevantPayload,
  SeekToPayload
} from '../../shared/bili'
import type {
  DailyStat,
  FeedbackEntry,
  FeedbackStats,
  PlayRecord,
  PlayRecordTick,
  PlayRecordUpdate,
  ProgressFilter,
  ProgressStats,
  StudySession
} from '../../shared/stats'
import type { BackupMeta, ImportPreview } from '../../shared/backup'
import { join } from 'path'
import { ValidationError, str, optStr, num, optNum, arr, oneOf, safeRecord } from '../validate'

/**
 * 视频学习模式模块入口（接入强制引擎 + 四层导航判定）。
 * 注册全部 视频学习相关 IPC 处理器，并预热 WBI 密钥缓存。
 * 编排责任：打开视频 → 启动强制会话 + 全屏锁定；关闭视频 → 结束强制会话。
 */

/** 导入路径令牌：importPreview 选定的文件，importData 仅认该路径（10 分钟内、一次性） */
const IMPORT_TOKEN_TTL_MS = 10 * 60_000
let pendingImport: { filePath: string; expiresAt: number } | null = null

export function registerNavigationModule(
  getWindow: () => BrowserWindow | null,
  enforcement: EnforcementHandle,
  session: SessionHandle
): void {
  /** H-01：规范化单条笔记（字段类型 + 长度校验，丢弃未知/畸形字段） */
  const normalizeNote = (raw: unknown, label: string): NoteEntry => {
    const e = safeRecord(raw)
    const note: NoteEntry = {
      id: str(e.id, `${label}.id`, { max: 200 }),
      createdAt: num(e.createdAt, `${label}.createdAt`),
      content: e.content === undefined ? '' : str(e.content, `${label}.content`, { max: 200_000 })
    }
    if (e.bvid !== undefined) note.bvid = str(e.bvid, `${label}.bvid`, { max: 100 })
    if (e.videoTitle !== undefined)
      note.videoTitle = str(e.videoTitle, `${label}.videoTitle`, { max: 1000 })
    if (e.timestampS !== undefined) note.timestampS = num(e.timestampS, `${label}.timestampS`)
    if (typeof e.isKey === 'boolean') note.isKey = e.isKey
    if (e.source !== undefined) {
      const src = oneOf(
        e.source,
        `${label}.source`,
        ['main', 'overlay', 'ai', 'time-mark'] as const,
        true
      )
      if (src) note.source = src
    }
    return note
  }

  registerVideoEvents({
    getMainWindow: getWindow,
    // P-2：创建视频窗口之前前置释放主窗口学习会话遮罩
    // （session.start 施加的 screen-saver 置顶遮罩恒高于未置顶的视频窗口，会盖住视频）
    onBeforeOpen: () => {
      session.suspendOverlay()
    },
    onOpen: (video, payload) => {
      try {
        enforcement.enterBiliSession(video, {
          plannedMs: payload.plannedMs ?? 0,
          topic: payload.topic ?? ''
        })
        // F-3/M2：打开视频 → upsert play_records 并累加观看次数（标题快照用于进度页归档；
        // coverUrl / author 快照用于记录卡片封面与 UP 主展示）
        const prev = getPlayRecord(payload.bvid)
        upsertPlayRecord({
          bvid: payload.bvid,
          title: payload.title,
          viewedCount: (prev?.viewedCount ?? 0) + 1,
          coverUrl: payload.coverUrl,
          author: payload.author
        })
        // 悬浮面板必须始终浮于视频之上：登记失焦拉回豁免（面板交互不抢焦点）+ 防御性提升置顶
        // （applyLevelWindow 已跳过视频窗口的 screen-saver 置顶，此处兜底同级 z-order 竞争）
        enforcement.setOverlayExempt(getOverlayWindow())
        ensureOverlayOnTop()
      } catch (err) {
        // P-2：强制会话启动失败（如恢复码前置校验异常）→ 回滚关闭视频窗口，
        // 避免"窗口已创建但会话失败"的半开中间态。
        // 注意：closeVideo 会同步 video.destroy()，而 openVideo 在 onOpen 返回后
        // 仍会访问 video（如 isFullScreen() 上报状态）——销毁动作推迟到 openVideo
        // 返回后再执行，避免"openVideo 继续访问已销毁窗口"抛错。
        console.error('[bili] 强制会话启动失败，关闭视频窗口:', err)
        setImmediate(() => {
          try {
            closeVideo()
          } catch {
            /* 忽略 */
          }
        })
      } finally {
        // P-2：无论成功与否都挂起主窗口学习会话遮罩（视频窗口自身全屏锁定接管）；
        // 防止 onOpen 中途抛错导致 suspendOverlay 永不执行、主窗口遮罩永久残留盖住视频
        session.suspendOverlay()
      }
    },
    onClose: () => {
      enforcement.exitBiliSession('manual')
      enforcement.setOverlayExempt(null)
      // 视频关闭后恢复主窗口学习会话遮罩（若会话仍在进行且设置开启）
      session.resumeOverlay()
    },
    // P-2：主进程兜底 5×Esc（视频窗口聚焦时主窗口渲染层收不到 Esc，渲染层检测失效）：
    // 唤起主窗口紧急退出弹窗（渲染层收到事件后暂停失焦拉回）
    onEscapeSpam: () => {
      const main = getWindow()
      if (main && !main.isDestroyed()) {
        main.show()
        main.focus()
        main.webContents.send(IPC_EVENTS.bili.emergencyRequest, {})
      }
    }
  })

  // 启动预热设备指纹与 WBI 密钥（4h/24h 缓存；失败静默，首次搜索时重试）
  warmupFingerprint()
  warmupWbiCache()

  /* ===== 搜索 ===== */
  ipcMain.handle(
    IPC_CHANNELS.bili.search,
    async (
      _event,
      keyword: string,
      options?: Partial<BiliSearchOptions>
    ): Promise<BiliSearchResponse> => {
      // H-01：keyword 必填字符串；options 逐项校验（防超长/畸形）
      const kw = str(keyword, 'bili.search.keyword', { max: 500 })
      const opts = options ?? {}
      const page = optNum(opts.page, 'bili.search.page')
      const order = oneOf(
        opts.order,
        'bili.search.order',
        ['totalrank', 'click', 'pubdate'] as const,
        true
      )
      const duration = optNum(opts.duration, 'bili.search.duration')
      const clean: Partial<BiliSearchOptions> = {}
      if (page !== undefined) clean.page = page
      if (order !== undefined) clean.order = order
      if (duration !== undefined) clean.duration = duration
      return searchBiliVideo({ keyword: kw, ...clean })
    }
  )

  /* ===== 播放窗口 ===== */
  ipcMain.handle(IPC_CHANNELS.bili.openVideo, (_event, payload: OpenVideoPayload): void => {
    // H-01：运行时校验 OpenVideoPayload（bvid 必填；其余字段类型约束）
    const p = safeRecord(payload)
    const bvid = str(p.bvid, 'bili.openVideo.bvid', { max: 100 })
    const open: OpenVideoPayload = { bvid, autoFullscreen: p.autoFullscreen === true }
    if (p.topic !== undefined) open.topic = optStr(p.topic, 'bili.openVideo.topic', { max: 500 })
    if (p.title !== undefined) open.title = optStr(p.title, 'bili.openVideo.title', { max: 1000 })
    if (p.plannedMs !== undefined) {
      const ms = num(p.plannedMs, 'bili.openVideo.plannedMs')
      if (ms < 0 || ms > 24 * 60 * 60 * 1000)
        throw new ValidationError('bili.openVideo.plannedMs 超出范围')
      open.plannedMs = ms
    }
    if (p.seekSeconds !== undefined)
      open.seekSeconds = num(p.seekSeconds, 'bili.openVideo.seekSeconds')
    if (p.source !== undefined) {
      const src = oneOf(
        p.source,
        'bili.openVideo.source',
        ['manual', 'resume', 'search'] as const,
        true
      )
      if (src) open.source = src
    }
    if (p.coverUrl !== undefined)
      open.coverUrl = optStr(p.coverUrl, 'bili.openVideo.coverUrl', { max: 2000 })
    if (p.author !== undefined)
      open.author = optStr(p.author, 'bili.openVideo.author', { max: 500 })
    // P-2：恢复码前置校验前移——L1/L2 未设恢复码直接拒绝，
    // 避免"视频窗口已创建但强制会话启动失败"的中间态（窗口半开 + 全屏无锁定）
    assertExitSafety(getSettings().lockLevel)
    try {
      // 内部 onBeforeOpen 会在创建视频窗口之前先释放主窗口学习会话遮罩
      openVideo(open)
    } catch (err) {
      // 打开失败回滚：恢复主窗口学习会话遮罩（会话仍在进行，遮罩不应丢失）
      session.resumeOverlay()
      throw err
    }
  })
  ipcMain.handle(IPC_CHANNELS.bili.closeVideo, (): void => {
    closeVideo()
  })
  ipcMain.handle(IPC_CHANNELS.bili.videoState, (): VideoState => getVideoState())
  ipcMain.handle(IPC_CHANNELS.bili.getContext, (): BiliContext | null => getContext())

  /* ===== 悬浮面板 ===== */
  ipcMain.handle(IPC_CHANNELS.bili.overlaySetSize, (_event, size: OverlaySize): void => {
    const s = safeRecord(size)
    const width = num(s.width, 'overlay.size.width')
    const height = num(s.height, 'overlay.size.height')
    if (width <= 0 || height <= 0 || width > 10000 || height > 10000) {
      throw new ValidationError('overlay.size 超出允许范围')
    }
    resizeOverlay({ width, height })
  })
  // 状态机：expanded / minimized / hidden（已删除 collapsed 悬浮球态）
  ipcMain.handle(
    IPC_CHANNELS.bili.overlaySetState,
    (_event, state: OverlayState): OverlaySnapshot => {
      const s = oneOf(state, 'overlay.state', ['expanded', 'minimized', 'hidden'] as const)
      if (!s) throw new ValidationError('overlay.state 非法')
      return setOverlayState(s)
    }
  )
  ipcMain.handle(IPC_CHANNELS.bili.overlayGetState, (): OverlaySnapshot => getOverlaySnapshot())
  ipcMain.handle(IPC_CHANNELS.bili.overlayToggleHide, (): OverlaySnapshot => toggleOverlayHide())

  /* ===== 导航判定 ===== */
  const navCheck = (_event: unknown, url: string): NavVerdict => {
    const u = str(url ?? '', 'nav.url', { max: 5000 })
    return isAllowedBiliUrl(u)
  }
  ipcMain.handle(IPC_CHANNELS.bili.navCheck, navCheck)
  // 兼容既有骨架通道 nav:check
  ipcMain.handle(IPC_CHANNELS.nav.check, navCheck)

  /* ===== 标记为相关（BV 白名单） ===== */
  ipcMain.handle(
    IPC_CHANNELS.bili.markRelevant,
    (_event, payload: MarkRelevantPayload): boolean => {
      const p = safeRecord(payload)
      const bvid = str(p.bvid, 'bili.markRelevant.bvid', { max: 100 })
      return markRelevant(bvid)
    }
  )

  /* ===== 时间点标记跳转（F-2） ===== */
  ipcMain.handle(IPC_CHANNELS.bili.seekTo, (_event, payload: SeekToPayload): Promise<boolean> => {
    const p = safeRecord(payload)
    const bvid = str(p.bvid, 'bili.seekTo.bvid', { max: 100 })
    const seconds = num(p.seconds, 'bili.seekTo.seconds')
    return seekTo(bvid, seconds)
  })
  ipcMain.handle(IPC_CHANNELS.bili.getVideoPosition, (): Promise<number> => getVideoPosition())
  ipcMain.handle(IPC_CHANNELS.bili.getVideoDuration, (): Promise<number> => getVideoDuration())

  /* ===== 记事本（增量 upsert + 分视频归档，F-1/P-1） ===== */
  ipcMain.handle(IPC_CHANNELS.notes.load, async (): Promise<NoteEntry[]> => loadNotesAll())
  ipcMain.handle(IPC_CHANNELS.notes.save, async (_event, entries: NoteEntry[]): Promise<void> => {
    const list = arr(entries, 'notes.save', { max: 5000, itemString: false }) as NoteEntry[]
    saveNotesAll(list.map((e) => normalizeNote(e, 'notes.save')))
  })
  ipcMain.handle(
    IPC_CHANNELS.notes.upsert,
    async (_event, entry: NoteEntry): Promise<NoteEntry> => {
      return upsertNote(normalizeNote(entry, 'notes.upsert'))
    }
  )
  ipcMain.handle(IPC_CHANNELS.notes.delete, async (_event, id: string): Promise<void> => {
    deleteNote(str(id, 'notes.id', { max: 200 }))
  })
  ipcMain.handle(
    IPC_CHANNELS.notes.loadByVideo,
    async (_event, bvid: string): Promise<NoteEntry[]> => {
      return loadNotesByVideo(str(bvid, 'notes.bvid', { max: 100 }))
    }
  )

  /* ===== 按视频学习进度（F-3） ===== */
  ipcMain.handle(
    IPC_CHANNELS.playRecords.tick,
    async (_event, tick: PlayRecordTick): Promise<PlayRecord | null> => {
      const t = safeRecord(tick)
      const clean: PlayRecordTick = {
        bvid: str(t.bvid, 'playRecords.tick.bvid', { max: 100 }),
        watchedDeltaS: num(t.watchedDeltaS, 'playRecords.tick.watchedDeltaS'),
        positionS: num(t.positionS, 'playRecords.tick.positionS')
      }
      if (t.title !== undefined) clean.title = str(t.title, 'playRecords.tick.title', { max: 1000 })
      if (t.durationS !== undefined)
        clean.durationS = num(t.durationS, 'playRecords.tick.durationS')
      return tickPlayRecord(clean)
    }
  )
  ipcMain.handle(IPC_CHANNELS.playRecords.list, async (): Promise<PlayRecord[]> =>
    listPlayRecords()
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.markDone,
    async (_event, bvid: string): Promise<PlayRecord | null> =>
      markPlayRecordDone(str(bvid, 'playRecords.bvid', { max: 100 }))
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.setGoal,
    async (
      _event,
      payload: { bvid: string; goalRounds: number; goalDeadline?: string }
    ): Promise<PlayRecord | null> => {
      const p = safeRecord(payload)
      const bvid = str(p.bvid, 'playRecords.setGoal.bvid', { max: 100 })
      const goalRounds = num(p.goalRounds, 'playRecords.setGoal.goalRounds')
      const goalDeadline =
        p.goalDeadline === undefined
          ? undefined
          : str(p.goalDeadline, 'playRecords.setGoal.goalDeadline', { max: 50 })
      return setPlayGoal(bvid, { goalRounds, goalDeadline })
    }
  )

  /* ===== 按视频学习进度（M1 管理 / M2 快捷访问 / M3 统计） ===== */
  ipcMain.handle(
    IPC_CHANNELS.playRecords.get,
    async (_event, bvid: string): Promise<PlayRecord | null> =>
      getPlayRecord(str(bvid, 'playRecords.bvid', { max: 100 }))
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.delete,
    async (_event, bvid: string, opts?: { deleteNotes?: boolean }): Promise<boolean> => {
      const o = safeRecord(opts)
      return deletePlayRecord(str(bvid, 'playRecords.bvid', { max: 100 }), {
        deleteNotes: o.deleteNotes === true
      })
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.batchDelete,
    async (_event, bvids: string[]): Promise<number> =>
      batchDeletePlayRecords(
        arr(bvids, 'playRecords.batchDelete', { max: 2000, itemString: true }) as string[]
      )
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.update,
    async (_event, bvid: string, updates: PlayRecordUpdate): Promise<PlayRecord | null> => {
      const u = safeRecord(updates)
      return updatePlayRecord(
        str(bvid, 'playRecords.bvid', { max: 100 }),
        u as unknown as PlayRecordUpdate
      )
    }
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.batchUpdate,
    async (_event, bvids: string[], updates: PlayRecordUpdate): Promise<number> =>
      batchUpdatePlayRecords(
        arr(bvids, 'playRecords.batchUpdate', { max: 2000, itemString: true }) as string[],
        safeRecord(updates) as unknown as PlayRecordUpdate
      )
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.search,
    async (_event, filter: ProgressFilter): Promise<PlayRecord[]> => searchPlayRecords(filter ?? {})
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.setTags,
    async (_event, bvid: string, tags: string[]): Promise<PlayRecord | null> =>
      setPlayRecordTags(
        str(bvid, 'playRecords.bvid', { max: 100 }),
        arr(tags, 'playRecords.tags', { max: 100, itemString: true }) as string[]
      )
  )
  ipcMain.handle(IPC_CHANNELS.playRecords.getTags, async (): Promise<string[]> =>
    getAllPlayRecordTags()
  )
  ipcMain.handle(IPC_CHANNELS.playRecords.getStats, async (): Promise<ProgressStats> =>
    getProgressStats()
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.getSessions,
    async (_event, bvid: string, limit?: number): Promise<StudySession[]> =>
      getStudySessionsByVideo(
        str(bvid, 'playRecords.bvid', { max: 100 }),
        optNum(limit, 'playRecords.limit')
      )
  )

  /* ===== M4 每日学习时长（柱状图） ===== */
  ipcMain.handle(
    IPC_CHANNELS.playRecords.getDailyStats,
    async (_event, days: number): Promise<DailyStat[]> =>
      getDailyStudyMinutes(num(days, 'playRecords.days'))
  )

  /* ===== M5 数据备份（导出 / 导入 / 元数据） ===== */
  // 手动备份：主进程弹保存对话框 → 写 JSON（spec：主进程读取数据序列化写入文件）
  ipcMain.handle(
    IPC_CHANNELS.playRecords.exportData,
    async (): Promise<{
      ok: boolean
      canceled?: boolean
      filePath?: string
      recordCount?: number
      error?: string
    }> => {
      const backup = buildBackupFile()
      const win = getWindow()
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const options = {
        title: '备份学习数据',
        defaultPath: join(app.getPath('documents'), `pomodoro-backup-${stamp}.json`),
        filters: [{ name: 'JSON 备份', extensions: ['json'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      try {
        const meta = writeBackupFile(result.filePath, backup, 'manual')
        return { ok: true, filePath: result.filePath, recordCount: meta.recordCount }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  // 恢复第一步：选择文件 + 解析校验，返回预览（导入模式由用户后续确认）
  ipcMain.handle(
    IPC_CHANNELS.playRecords.importPreview,
    async (): Promise<{
      ok: boolean
      canceled?: boolean
      filePath?: string
      preview?: ImportPreview
      error?: string
    }> => {
      const win = getWindow()
      const options = {
        title: '选择备份文件',
        filters: [{ name: 'JSON 备份', extensions: ['json'] }],
        properties: ['openFile' as const]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true }
      const filePath = result.filePaths[0]
      try {
        const backup = readBackupFile(filePath)
        // 路径令牌：只有经原生对话框选中并预览成功的文件才允许后续导入
        pendingImport = { filePath, expiresAt: Date.now() + IMPORT_TOKEN_TTL_MS }
        return {
          ok: true,
          filePath,
          preview: {
            exportedAt: backup.exportedAt,
            recordCount: backup.data.playRecords.length,
            noteCount: backup.data.notes.length,
            sessionCount: backup.data.studySessions.length,
            taskCount: backup.data.tasks?.length ?? 0
          }
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  // 恢复第二步：执行（merge / replace）
  ipcMain.handle(
    IPC_CHANNELS.playRecords.importData,
    async (
      _event,
      filePath: string,
      mode: 'merge' | 'replace'
    ): Promise<{
      ok: boolean
      records: number
      notes: number
      sessions: number
      tasks?: number
      error?: string
    }> => {
      try {
        const fp = str(filePath ?? '', 'playRecords.importData.filePath', { max: 2000 })
        const m = oneOf(mode, 'playRecords.importData.mode', ['merge', 'replace'] as const)
        if (!m) throw new ValidationError('importData.mode 必须是 merge/replace')
        // 渲染层传入的路径必须与主进程记录的"对话框选定路径"一致且未过期；
        // 否则被攻破的渲染进程可让主进程读取任意本地 JSON 文件
        const token = pendingImport
        if (!token || token.filePath !== fp || Date.now() > token.expiresAt) {
          throw new Error('请先通过「选择备份文件」选定要恢复的文件')
        }
        const backup = readBackupFile(fp)
        const result = importBackupData(backup.data, m)
        const taskResult = importTaskBackup(
          {
            tasks: backup.data.tasks ?? [],
            focusSessions: backup.data.focusSessions ?? [],
            interruptionEvents: backup.data.interruptionEvents ?? []
          },
          m
        )
        pendingImport = null // 令牌一次性有效
        return { ok: true, ...result, tasks: taskResult.tasks }
      } catch (err) {
        return {
          ok: false,
          records: 0,
          notes: 0,
          sessions: 0,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
  ipcMain.handle(IPC_CHANNELS.playRecords.listBackups, async (): Promise<BackupMeta[]> =>
    listBackupMeta()
  )

  /* ===== 用户反馈（R-1，本地落库） ===== */
  ipcMain.handle(
    IPC_CHANNELS.feedback.submit,
    async (
      _event,
      payload: { mode: string; rating: number; category?: string; detail?: string }
    ): Promise<FeedbackEntry | null> => {
      const p = safeRecord(payload)
      const mode = str(p.mode, 'feedback.mode', { max: 50 })
      const rating = num(p.rating, 'feedback.rating')
      const category =
        p.category === undefined ? undefined : str(p.category, 'feedback.category', { max: 100 })
      const detail =
        p.detail === undefined ? undefined : str(p.detail, 'feedback.detail', { max: 5000 })
      return addFeedback({ mode, rating, category, detail })
    }
  )
  ipcMain.handle(IPC_CHANNELS.feedback.list, async (): Promise<FeedbackEntry[]> => listFeedback())
  ipcMain.handle(IPC_CHANNELS.feedback.stats, async (): Promise<FeedbackStats> =>
    getFeedbackStats()
  )

  /* ===== 匿名遥测（R-2，opt-in） ===== */
  // 必须走 recordTelemetry（内部校验 telemetryEnabled 开关）：直接调用 storage.recordEvent
  // 会绕过用户关闭采集的隐私选择，前端事件在开关关闭后仍被记录
  ipcMain.handle(
    IPC_CHANNELS.telemetry.record,
    async (
      _event,
      payload: { domain: string; action: string; data?: Record<string, unknown> }
    ): Promise<void> => {
      if (!payload || typeof payload.domain !== 'string' || typeof payload.action !== 'string')
        return
      recordTelemetry(payload.domain, payload.action, payload.data)
    }
  )

  /* ===== 调试辅助 ===== */
  ipcMain.handle(IPC_CHANNELS.bili.resetWbi, (): void => {
    resetWbiCache()
  })
}
