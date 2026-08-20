import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '../ipc'
import { searchBiliVideo } from './biliSearch'
import { warmupWbiCache, resetWbiCache } from './wbi'
import { isAllowedBiliUrl } from './guard'
import { getSettings } from '../storage/settings'
import { assertExitSafety } from '../enforcement/emergencyExit'
import {
  closeVideo,
  ensureOverlayOnTop,
  getContext,
  getOverlaySnapshot,
  getOverlayWindow,
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
  deleteNote,
  getFeedbackStats,
  getPlayRecord,
  listFeedback,
  listPlayRecords,
  loadNotesAll,
  loadNotesByVideo,
  markPlayRecordDone,
  recordEvent,
  saveNotesAll,
  setPlayGoal,
  tickPlayRecord,
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
  FeedbackEntry,
  FeedbackStats,
  PlayRecord,
  PlayRecordTick
} from '../../shared/stats'

/**
 * B 站模式模块入口（接入强制引擎 + 四层导航判定）。
 * 注册全部 B 站相关 IPC 处理器，并预热 WBI 密钥缓存。
 * 编排责任：打开视频 → 启动强制会话 + 全屏锁定；关闭视频 → 结束强制会话。
 */

export function registerNavigationModule(
  getWindow: () => BrowserWindow | null,
  enforcement: EnforcementHandle,
  session: SessionHandle
): void {
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
        // F-3：打开视频 → upsert play_records 并累加观看次数（标题快照用于进度页归档）
        const prev = getPlayRecord(payload.bvid)
        upsertPlayRecord({
          bvid: payload.bvid,
          title: payload.title,
          viewedCount: (prev?.viewedCount ?? 0) + 1
        })
        // 悬浮面板必须始终浮于视频之上：登记失焦拉回豁免（面板交互不抢焦点）+ 防御性提升置顶
        // （applyLevelWindow 已跳过视频窗口的 screen-saver 置顶，此处兜底同级 z-order 竞争）
        enforcement.setOverlayExempt(getOverlayWindow())
        ensureOverlayOnTop()
      } catch (err) {
        // P-2：强制会话启动失败（如恢复码前置校验异常）→ 回滚关闭视频窗口，
        // 避免"窗口已创建但会话失败"的半开中间态
        console.error('[bili] 强制会话启动失败，关闭视频窗口:', err)
        try {
          closeVideo()
        } catch {
          /* 忽略 */
        }
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

  // 启动预热 WBI 密钥（4h 缓存；失败静默，首次搜索时重试）
  warmupWbiCache()

  /* ===== 搜索 ===== */
  ipcMain.handle(
    IPC_CHANNELS.bili.search,
    async (_event, keyword: string, options?: Partial<BiliSearchOptions>): Promise<BiliSearchResponse> => {
      return searchBiliVideo({ keyword, ...options })
    }
  )

  /* ===== 播放窗口 ===== */
  ipcMain.handle(IPC_CHANNELS.bili.openVideo, (_event, payload: OpenVideoPayload): void => {
    // P-2：恢复码前置校验前移——L1/L2 未设恢复码直接拒绝，
    // 避免"视频窗口已创建但强制会话启动失败"的中间态（窗口半开 + 全屏无锁定）
    assertExitSafety(getSettings().lockLevel)
    try {
      // 内部 onBeforeOpen 会在创建视频窗口之前先释放主窗口学习会话遮罩
      openVideo(payload)
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
    resizeOverlay(size)
  })
  // 状态机：expanded / minimized / hidden（已删除 collapsed 悬浮球态）
  ipcMain.handle(
    IPC_CHANNELS.bili.overlaySetState,
    (_event, state: OverlayState): OverlaySnapshot => setOverlayState(state)
  )
  ipcMain.handle(IPC_CHANNELS.bili.overlayGetState, (): OverlaySnapshot => getOverlaySnapshot())
  ipcMain.handle(IPC_CHANNELS.bili.overlayToggleHide, (): OverlaySnapshot => toggleOverlayHide())

  /* ===== 导航判定 ===== */
  const navCheck = (_event: unknown, url: string): NavVerdict => isAllowedBiliUrl(url)
  ipcMain.handle(IPC_CHANNELS.bili.navCheck, navCheck)
  // 兼容既有骨架通道 nav:check
  ipcMain.handle(IPC_CHANNELS.nav.check, navCheck)

  /* ===== 标记为相关（BV 白名单） ===== */
  ipcMain.handle(
    IPC_CHANNELS.bili.markRelevant,
    (_event, payload: MarkRelevantPayload): boolean => {
      return markRelevant(payload.bvid)
    }
  )

  /* ===== 时间点标记跳转（F-2） ===== */
  ipcMain.handle(IPC_CHANNELS.bili.seekTo, (_event, payload: SeekToPayload): Promise<boolean> => {
    return seekTo(payload.bvid, payload.seconds)
  })
  ipcMain.handle(IPC_CHANNELS.bili.getVideoPosition, (): Promise<number> => getVideoPosition())

  /* ===== 记事本（增量 upsert + 分视频归档，F-1/P-1） ===== */
  ipcMain.handle(IPC_CHANNELS.notes.load, async (): Promise<NoteEntry[]> => loadNotesAll())
  ipcMain.handle(IPC_CHANNELS.notes.save, async (_event, entries: NoteEntry[]): Promise<void> => {
    saveNotesAll(entries)
  })
  ipcMain.handle(IPC_CHANNELS.notes.upsert, async (_event, entry: NoteEntry): Promise<NoteEntry> => {
    return upsertNote(entry)
  })
  ipcMain.handle(IPC_CHANNELS.notes.delete, async (_event, id: string): Promise<void> => {
    deleteNote(id)
  })
  ipcMain.handle(IPC_CHANNELS.notes.loadByVideo, async (_event, bvid: string): Promise<NoteEntry[]> => {
    return loadNotesByVideo(bvid)
  })

  /* ===== 按视频学习进度（F-3） ===== */
  ipcMain.handle(IPC_CHANNELS.playRecords.tick, async (_event, tick: PlayRecordTick): Promise<PlayRecord | null> => {
    return tickPlayRecord(tick)
  })
  ipcMain.handle(IPC_CHANNELS.playRecords.list, async (): Promise<PlayRecord[]> => listPlayRecords())
  ipcMain.handle(
    IPC_CHANNELS.playRecords.markDone,
    async (_event, bvid: string): Promise<PlayRecord | null> => markPlayRecordDone(bvid)
  )
  ipcMain.handle(
    IPC_CHANNELS.playRecords.setGoal,
    async (_event, payload: { bvid: string; goalRounds: number; goalDeadline?: string }): Promise<PlayRecord | null> => {
      return setPlayGoal(payload.bvid, { goalRounds: payload.goalRounds, goalDeadline: payload.goalDeadline })
    }
  )

  /* ===== 用户反馈（R-1，本地落库） ===== */
  ipcMain.handle(
    IPC_CHANNELS.feedback.submit,
    async (
      _event,
      payload: { mode: string; rating: number; category?: string; detail?: string }
    ): Promise<FeedbackEntry | null> => {
      return addFeedback(payload)
    }
  )
  ipcMain.handle(IPC_CHANNELS.feedback.list, async (): Promise<FeedbackEntry[]> => listFeedback())
  ipcMain.handle(IPC_CHANNELS.feedback.stats, async (): Promise<FeedbackStats> => getFeedbackStats())

  /* ===== 匿名遥测（R-2，opt-in；telemetry.ts 已按开关过滤） ===== */
  ipcMain.handle(
    IPC_CHANNELS.telemetry.record,
    async (_event, payload: { domain: string; action: string; data?: Record<string, unknown> }): Promise<void> => {
      if (!payload || typeof payload.domain !== 'string' || typeof payload.action !== 'string') return
      recordEvent(payload.domain, payload.action, payload.data)
    }
  )

  /* ===== 调试辅助 ===== */
  ipcMain.handle(IPC_CHANNELS.bili.resetWbi, (): void => {
    resetWbiCache()
  })
}