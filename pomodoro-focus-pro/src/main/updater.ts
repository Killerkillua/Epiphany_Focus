import { app, BrowserWindow, ipcMain } from 'electron'
import { EventEmitter } from 'node:events'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import type { UpdateActionResult, UpdateState, UpdateStatus } from '../shared/ipc'
import { logger } from './logger'
import { showAppNotification } from './notify'

/** electron-updater 可注入接口（便于单测） */
export interface AutoUpdaterLike extends EventEmitter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterDeps {
  getWindow: () => BrowserWindow | null
  isQuitBlocked: () => boolean
  backupBeforeInstall: () => Promise<void>
  /** 默认 process.platform，单测可注入 */
  platform?: string
  showNotification?: (title: string, body: string) => void
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>
}

export interface UpdaterController {
  check(): Promise<UpdateActionResult & { state: UpdateState }>
  download(): Promise<UpdateActionResult & { state: UpdateState }>
  install(): Promise<UpdateActionResult & { state: UpdateState }>
  getState(): UpdateState
  handleAutoUpdaterEvent(event: string, ...args: unknown[]): void
  notifyIfPending(): void
  startPendingPoll(): void
  stopPendingPoll(): void
}

const POLL_MS = 15_000
const INITIAL_CHECK_DELAY_MS = 10_000
const PERIODIC_CHECK_MS = 4 * 60 * 60 * 1000

function idleState(): UpdateState {
  return { status: 'idle' }
}

function darwinManualMessage(): string {
  return 'macOS 请手动下载新版本'
}

export function createUpdater(deps: UpdaterDeps, autoUpdater: AutoUpdaterLike): UpdaterController {
  const platform = deps.platform ?? process.platform
  const log = deps.log ?? logger
  const notify = deps.showNotification ?? showAppNotification

  let state: UpdateState = idleState()
  let pendingInstall = false
  let pendingNotified = false
  let notifiedVersion: string | undefined
  let pendingPoll: NodeJS.Timeout | null = null

  const setState = (next: UpdateState): void => {
    state = next
    broadcast(deps.getWindow(), next)
  }

  const result = (
    ok: boolean,
    extra?: Partial<UpdateActionResult>
  ): UpdateActionResult & { state: UpdateState } => ({
    ok,
    state,
    ...extra
  })

  const isDarwin = (): boolean => platform === 'darwin'

  const handleAutoUpdaterEvent = (event: string, ...args: unknown[]): void => {
    switch (event) {
      case 'checking-for-update':
        log.info('updater', 'checking for update')
        setState({ status: 'checking' })
        break
      case 'update-available': {
        const info = args[0] as { version?: string; releaseNotes?: string | null } | undefined
        const version = info?.version
        const releaseNotes =
          typeof info?.releaseNotes === 'string'
            ? info.releaseNotes
            : info?.releaseNotes != null
              ? String(info.releaseNotes)
              : undefined
        log.info('updater', `update available: ${version ?? 'unknown'}`)
        setState({ status: 'available', version, releaseNotes })
        if (version && notifiedVersion !== version) {
          notifiedVersion = version
          notify('发现新版本', version ? `静界专注 ${version} 可更新` : '发现新版本可更新')
        }
        break
      }
      case 'update-not-available':
        log.info('updater', 'update not available')
        setState({ status: 'not-available' })
        break
      case 'download-progress': {
        const progress = args[0] as { percent?: number } | undefined
        const percent = progress?.percent
        log.info('updater', `download progress: ${percent ?? 0}%`)
        setState({
          ...state,
          status: 'downloading',
          percent: typeof percent === 'number' ? percent : state.percent
        })
        break
      }
      case 'update-downloaded': {
        const info = args[0] as { version?: string; releaseNotes?: string | null } | undefined
        const version = info?.version ?? state.version
        const releaseNotes =
          typeof info?.releaseNotes === 'string'
            ? info.releaseNotes
            : info?.releaseNotes != null
              ? String(info.releaseNotes)
              : state.releaseNotes
        log.info('updater', `update downloaded: ${version ?? 'unknown'}`)
        setState({ status: 'downloaded', version, releaseNotes, percent: 100 })
        break
      }
      case 'error': {
        const err = args[0] as Error | undefined
        const message = err instanceof Error ? err.message : String(err ?? 'unknown error')
        log.error('updater', 'update error:', message)
        setState({ status: 'error', error: message })
        break
      }
      default:
        break
    }
  }

  const check = async (): Promise<UpdateActionResult & { state: UpdateState }> => {
    if (isDarwin()) {
      return result(false, { message: darwinManualMessage() })
    }
    if (state.status === 'checking' || state.status === 'downloading') {
      return result(true)
    }
    try {
      await autoUpdater.checkForUpdates()
      return result(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('updater', 'checkForUpdates failed:', message)
      setState({ status: 'error', error: message })
      return result(false, { message })
    }
  }

  const download = async (): Promise<UpdateActionResult & { state: UpdateState }> => {
    if (isDarwin()) {
      return result(false, { message: darwinManualMessage() })
    }
    if (state.status === 'downloading') {
      return result(true)
    }
    if (state.status !== 'available') {
      return result(false, { message: '当前没有可下载的更新' })
    }
    try {
      await autoUpdater.downloadUpdate()
      return result(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('updater', 'downloadUpdate failed:', message)
      setState({ status: 'error', error: message })
      return result(false, { message })
    }
  }

  const install = async (): Promise<UpdateActionResult & { state: UpdateState }> => {
    if (isDarwin()) {
      return result(false, { message: darwinManualMessage() })
    }
    if (state.status !== 'downloaded') {
      return result(false, { message: '更新尚未下载完成' })
    }
    if (deps.isQuitBlocked()) {
      pendingInstall = true
      pendingNotified = false
      startPendingPoll()
      return result(false, {
        blocked: true,
        message: '专注会话结束后可安装'
      })
    }
    try {
      await deps.backupBeforeInstall()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('updater', 'backup before install failed:', message)
      setState({ status: 'error', error: message })
      return result(false, { message: `安装前备份失败: ${message}` })
    }
    pendingInstall = false
    pendingNotified = false
    autoUpdater.quitAndInstall()
    return result(true)
  }

  const notifyIfPending = (): void => {
    if (!pendingInstall || pendingNotified) return
    if (state.status !== 'downloaded') return
    if (deps.isQuitBlocked()) return
    pendingNotified = true
    broadcast(deps.getWindow(), state)
    notify('更新已就绪', '专注已结束，可重启安装更新')
  }

  const startPendingPoll = (): void => {
    if (pendingPoll) return
    pendingPoll = setInterval(() => {
      notifyIfPending()
    }, POLL_MS)
  }

  const stopPendingPoll = (): void => {
    if (pendingPoll) {
      clearInterval(pendingPoll)
      pendingPoll = null
    }
  }

  return {
    check,
    download,
    install,
    getState: () => state,
    handleAutoUpdaterEvent,
    notifyIfPending,
    startPendingPoll,
    stopPendingPoll
  }
}

function broadcast(win: BrowserWindow | null, state: UpdateState): void {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(IPC_EVENTS.update.statusChanged, state)
  } catch {
    /* 窗口销毁竞态 */
  }
}

let autoPollStarted = false
let periodicInterval: NodeJS.Timeout | null = null

/** 注册 IPC + 绑定真实 electron-updater（仅打包且非 macOS 时启动自动轮询） */
export function registerUpdater(deps: UpdaterDeps): UpdaterController {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  const controller = createUpdater(deps, autoUpdater as unknown as AutoUpdaterLike)

  const events = [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error'
  ] as const
  for (const ev of events) {
    autoUpdater.on(ev, (...args: unknown[]) => controller.handleAutoUpdaterEvent(ev, ...args))
  }

  ipcMain.handle(IPC_CHANNELS.update.check, () => controller.check())
  ipcMain.handle(IPC_CHANNELS.update.download, () => controller.download())
  ipcMain.handle(IPC_CHANNELS.update.install, () => controller.install())
  ipcMain.handle(IPC_CHANNELS.update.getStatus, () => controller.getState())

  if (app.isPackaged && (deps.platform ?? process.platform) !== 'darwin') {
    if (!autoPollStarted) {
      autoPollStarted = true
      setTimeout(() => {
        void controller.check().catch((err: unknown) => {
          logger.warn(
            'updater',
            'initial auto check failed:',
            err instanceof Error ? err.message : err
          )
        })
      }, INITIAL_CHECK_DELAY_MS)
      periodicInterval = setInterval(() => {
        void controller.check().catch((err: unknown) => {
          logger.warn(
            'updater',
            'periodic auto check failed:',
            err instanceof Error ? err.message : err
          )
        })
      }, PERIODIC_CHECK_MS)
      periodicInterval.unref?.()
    }
  }

  return controller
}

export type { UpdateState, UpdateStatus, UpdateActionResult }
