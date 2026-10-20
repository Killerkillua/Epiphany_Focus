import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { BrowserWindow } from 'electron'
import type { SessionHandle } from './index'
import type { SessionStartOptions, SessionState } from '../../shared/types'

/**
 * 学习会话模块测试（视频学习 / 英语学习计时，方案 2.2）。
 * 会话模块与强制引擎解耦：复用 TimerService 但不施加锁屏/守护。
 * 可测的纯逻辑：时长钳制（1s–8h，默认 1h）、模式选择、计时状态机、
 * 主窗口遮罩联动（start 施加 / 视频窗口挂起 / 恢复）。
 * Electron 与副作用依赖（db / biliWindow / lockScreen / telemetry）全部 mock。
 */

const mockDb = vi.hoisted(() => ({
  recordSessionStart: vi.fn(() => 42),
  recordSessionEnd: vi.fn(),
  recordStudyStats: vi.fn(),
  todayLocal: vi.fn(() => '2026-01-01')
}))

const mockBiliWindow = vi.hoisted(() => ({
  closeVideo: vi.fn(),
  getVideoState: vi.fn(() => ({ open: false, fullscreen: false, autoFullscreen: true }))
}))

const mockLockScreen = vi.hoisted(() => ({
  applyLevelWindow: vi.fn(),
  releaseLevelWindow: vi.fn()
}))

const mockSettings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({ sessionOverlay: true }))
}))

const mockTelemetry = vi.hoisted(() => ({
  recordTelemetry: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../storage/db', () => mockDb)
vi.mock('../navigation/biliWindow', () => mockBiliWindow)
vi.mock('../enforcement/lockScreen', () => mockLockScreen)
vi.mock('../storage/settings', () => mockSettings)
vi.mock('../telemetry', () => mockTelemetry)

type SessionModule = typeof import('./index')

let session: SessionModule
let handle: SessionHandle
let handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>

/** 主窗口假件：isDestroyed=false，遮罩函数可正常施加 */
function fakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

function start(opts?: SessionStartOptions): SessionState {
  return handlers.get(IPC_CHANNELS.session.start)!({}, opts) as SessionState
}

function stop(): SessionState {
  return handlers.get(IPC_CHANNELS.session.stop)!({}) as SessionState
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  // 重置所有 mock 到确定的默认行为
  mockDb.recordSessionStart.mockReset().mockReturnValue(42)
  mockDb.recordSessionEnd.mockReset()
  mockDb.recordStudyStats.mockReset()
  mockDb.todayLocal.mockReset().mockReturnValue('2026-01-01')
  mockBiliWindow.closeVideo.mockReset()
  mockBiliWindow.getVideoState
    .mockReset()
    .mockReturnValue({ open: false, fullscreen: false, autoFullscreen: true })
  mockLockScreen.applyLevelWindow.mockReset()
  mockLockScreen.releaseLevelWindow.mockReset()
  mockSettings.getSettings.mockReset().mockReturnValue({ sessionOverlay: true })
  mockTelemetry.recordTelemetry.mockReset()

  const electron = (await import('electron')) as unknown as {
    ipcMain: { handle: ReturnType<typeof vi.fn> }
  }
  session = await import('./index')
  handle = session.registerSessionModule(() => fakeWindow())
  handlers = new Map(
    electron.ipcMain.handle.mock.calls.map(
      ([ch, fn]) => [ch as string, fn as (event: unknown, ...args: unknown[]) => unknown] as const
    )
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('session:start 时长钳制', () => {
  it('<1s 取 1s；>8h 取 8h；非法/缺省取默认 1h', () => {
    expect(start({ mode: 'english', durationMs: 100 }).timer.durationMs).toBe(1_000)
    expect(start({ mode: 'english', durationMs: 10 * 3_600_000 }).timer.durationMs).toBe(
      8 * 3_600_000
    )
    expect(start({ mode: 'english', durationMs: Number.NaN }).timer.durationMs).toBe(60 * 60_000)
    expect(start(undefined).timer.durationMs).toBe(60 * 60_000)
    stop()
  })

  it('钳制后的时长用于落库（durationPlanned）与遥测', () => {
    start({ mode: 'english', durationMs: 100 })
    expect(mockDb.recordSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'english', level: 'L0', durationPlanned: 1_000 })
    )
    expect(mockTelemetry.recordTelemetry).toHaveBeenCalledWith('session', 'start', {
      mode: 'english',
      durationMinutes: 0
    })
    stop()
  })
})

describe('session:start 模式选择', () => {
  it('bili / english / 未知值 → english', () => {
    expect(start({ mode: 'bili', durationMs: 60_000 }).mode).toBe('bili')
    expect(start({ mode: 'english', durationMs: 60_000 }).mode).toBe('english')
    expect(start({ mode: 'other' as never, durationMs: 60_000 }).mode).toBe('english')
    stop()
  })
})

describe('计时状态机（pause / resume / get-state / stop）', () => {
  it('start→pause→resume→getState 状态流转', () => {
    start({ mode: 'english', durationMs: 60_000 })
    expect((handlers.get(IPC_CHANNELS.session.pause)!({}) as SessionState).timer.status).toBe(
      'paused'
    )
    expect((handlers.get(IPC_CHANNELS.session.resume)!({}) as SessionState).timer.status).toBe(
      'running'
    )
    expect((handlers.get(IPC_CHANNELS.session.getState)!({}) as SessionState).timer.status).toBe(
      'running'
    )
    stop()
  })

  it('stop 手动结束：计时器回 idle，学习统计与会话结算落库', () => {
    start({ mode: 'english', durationMs: 60_000 })
    const result = stop()
    expect(result.timer.status).toBe('idle')
    expect(mockDb.recordStudyStats).toHaveBeenCalled()
    expect(mockDb.recordSessionEnd).toHaveBeenCalled()
    // 遮罩解除
    expect(mockLockScreen.releaseLevelWindow).toHaveBeenCalled()
  })
})

describe('主窗口遮罩联动（SessionHandle）', () => {
  it('start（会话中、设置开启、无视频窗口）施加遮罩；stop 后解除', () => {
    start({ mode: 'english', durationMs: 60_000 })
    expect(mockLockScreen.applyLevelWindow).toHaveBeenCalledTimes(1)
    stop()
    expect(mockLockScreen.releaseLevelWindow).toHaveBeenCalled()
  })

  it('settings.sessionOverlay=false 时不施加遮罩', () => {
    mockSettings.getSettings.mockReturnValue({ sessionOverlay: false })
    start({ mode: 'english', durationMs: 60_000 })
    expect(mockLockScreen.applyLevelWindow).not.toHaveBeenCalled()
    stop()
  })

  it('suspendOverlay（视频窗口打开）释放遮罩；resumeOverlay（关闭）且会话进行中时恢复', () => {
    start({ mode: 'english', durationMs: 60_000 })
    expect(mockLockScreen.applyLevelWindow).toHaveBeenCalledTimes(1)

    handle.suspendOverlay()
    expect(mockLockScreen.releaseLevelWindow).toHaveBeenCalledTimes(1)

    handle.resumeOverlay()
    expect(mockLockScreen.applyLevelWindow).toHaveBeenCalledTimes(2)
    stop()
  })

  it('resumeOverlay 时会话未运行（idle）不恢复遮罩', () => {
    handle.resumeOverlay()
    expect(mockLockScreen.applyLevelWindow).not.toHaveBeenCalled()
  })

  it('resumeOverlay 时遮罩已施加（未被挂起）不重复施加', () => {
    start({ mode: 'english', durationMs: 60_000 })
    handle.resumeOverlay()
    expect(mockLockScreen.applyLevelWindow).toHaveBeenCalledTimes(1)
    stop()
  })
})
