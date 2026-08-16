import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../ipc'
import { searchBiliVideo } from './biliSearch'
import { warmupWbiCache, resetWbiCache } from './wbi'
import { isAllowedBiliUrl } from './guard'
import {
  closeVideo,
  getContext,
  getVideoState,
  markRelevant,
  openVideo,
  registerVideoEvents,
  resizeOverlay
} from './biliWindow'
import { loadNotesAll, saveNotesAll } from '../storage/db'
import type { EnforcementHandle } from '../enforcement'
import type {
  BiliSearchOptions,
  BiliSearchResponse,
  BiliContext,
  NavVerdict,
  OpenVideoPayload,
  OverlaySize,
  VideoState,
  NoteEntry,
  MarkRelevantPayload
} from '../../shared/bili'

/**
 * B 站模式模块入口（接入强制引擎 + 四层导航判定）。
 * 注册全部 B 站相关 IPC 处理器，并预热 WBI 密钥缓存。
 * 编排责任：打开视频 → 启动强制会话 + 全屏锁定；关闭视频 → 结束强制会话。
 */

export function registerNavigationModule(
  getWindow: () => BrowserWindow | null,
  enforcement: EnforcementHandle
): void {
  registerVideoEvents({
    getMainWindow: getWindow,
    onOpen: (video, payload) => {
      enforcement.enterBiliSession(video, {
        plannedMs: payload.plannedMs ?? 0,
        topic: payload.topic ?? ''
      })
    },
    onClose: () => enforcement.exitBiliSession('manual')
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
    openVideo(payload)
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

  /* ===== 记事本（中央 SQLite notes 表，整份覆盖语义兼容） ===== */
  ipcMain.handle(IPC_CHANNELS.notes.load, async (): Promise<NoteEntry[]> => loadNotesAll())
  ipcMain.handle(IPC_CHANNELS.notes.save, async (_event, entries: NoteEntry[]): Promise<void> => {
    saveNotesAll(entries)
  })

  /* ===== 调试辅助 ===== */
  ipcMain.handle(IPC_CHANNELS.bili.resetWbi, (): void => {
    resetWbiCache()
  })
}