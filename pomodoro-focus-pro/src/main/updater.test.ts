import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_EVENTS } from '../shared/ipc'
import { createUpdater, type AutoUpdaterLike, type UpdaterDeps } from './updater'

function makeFakeUpdater(): AutoUpdaterLike & {
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
} {
  const emitter = new EventEmitter()
  const checkForUpdates = vi.fn(async () => undefined)
  const downloadUpdate = vi.fn(async () => ['package'])
  const quitAndInstall = vi.fn()
  return Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall
  }) as AutoUpdaterLike & {
    checkForUpdates: ReturnType<typeof vi.fn>
    downloadUpdate: ReturnType<typeof vi.fn>
    quitAndInstall: ReturnType<typeof vi.fn>
  }
}

describe('createUpdater', () => {
  let send: ReturnType<typeof vi.fn>
  let backupBeforeInstallMock: ReturnType<typeof vi.fn>
  let isQuitBlockedMock: ReturnType<typeof vi.fn>
  let showNotificationMock: ReturnType<typeof vi.fn>
  let fake: ReturnType<typeof makeFakeUpdater>

  beforeEach(() => {
    send = vi.fn()
    backupBeforeInstallMock = vi.fn(async () => undefined)
    isQuitBlockedMock = vi.fn(() => false)
    showNotificationMock = vi.fn()
    fake = makeFakeUpdater()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function deps(platform = 'win32'): UpdaterDeps {
    return {
      getWindow: () =>
        ({
          isDestroyed: () => false,
          webContents: { send }
        }) as unknown as import('electron').BrowserWindow,
      isQuitBlocked: isQuitBlockedMock as () => boolean,
      backupBeforeInstall: backupBeforeInstallMock as () => Promise<void>,
      platform,
      showNotification: showNotificationMock as (title: string, body: string) => void
    }
  }

  it('update-available 更新状态并广播', () => {
    const ctrl = createUpdater(deps(), fake)
    ctrl.handleAutoUpdaterEvent('update-available', { version: '2.0.0', releaseNotes: 'notes' })
    expect(ctrl.getState()).toMatchObject({ status: 'available', version: '2.0.0' })
    expect(send).toHaveBeenCalledWith(IPC_EVENTS.update.statusChanged, ctrl.getState())
    expect(showNotificationMock).toHaveBeenCalledWith('发现新版本', '静界专注 2.0.0 可更新')
  })

  it('download-progress → update-downloaded', async () => {
    const ctrl = createUpdater(deps(), fake)
    ctrl.handleAutoUpdaterEvent('update-available', { version: '1.2.0' })
    ctrl.handleAutoUpdaterEvent('download-progress', { percent: 42 })
    expect(ctrl.getState().status).toBe('downloading')
    expect(ctrl.getState().percent).toBe(42)
    ctrl.handleAutoUpdaterEvent('update-downloaded', { version: '1.2.0' })
    expect(ctrl.getState()).toMatchObject({ status: 'downloaded', version: '1.2.0', percent: 100 })
  })

  it('install 在 quitBlocked 时不调用 quitAndInstall', async () => {
    isQuitBlockedMock.mockReturnValue(true)
    const ctrl = createUpdater(deps(), fake)
    ctrl.handleAutoUpdaterEvent('update-downloaded', { version: '1.2.0' })
    const res = await ctrl.install()
    expect(res.ok).toBe(false)
    expect(res.blocked).toBe(true)
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
    expect(backupBeforeInstallMock).not.toHaveBeenCalled()
  })

  it('install 成功时先备份再 quitAndInstall', async () => {
    const ctrl = createUpdater(deps(), fake)
    ctrl.handleAutoUpdaterEvent('update-downloaded', { version: '1.2.0' })
    const res = await ctrl.install()
    expect(res.ok).toBe(true)
    expect(backupBeforeInstallMock).toHaveBeenCalledOnce()
    expect(fake.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('error 事件进入 error 状态', () => {
    const ctrl = createUpdater(deps(), fake)
    ctrl.handleAutoUpdaterEvent('error', new Error('network down'))
    expect(ctrl.getState()).toMatchObject({ status: 'error', error: 'network down' })
  })

  it('darwin check 返回手动更新提示', async () => {
    const ctrl = createUpdater(deps('darwin'), fake)
    const res = await ctrl.check()
    expect(res.ok).toBe(false)
    expect(res.message).toContain('macOS')
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
  })
})
