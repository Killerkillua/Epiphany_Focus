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

/** 与 TimerService 单调时钟对齐（fake timers 只驱动 setInterval） */
let nowMs = 0

function advance(ms: number): void {
  nowMs += ms
  vi.advanceTimersByTime(ms)
}

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
  nowMs = 0
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => BigInt(nowMs * 1_000_000))
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
  vi.restoreAllMocks()
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

  it('study 模式保留；Infinity 时长回退默认 1h', () => {
    // 输入：mode=study；durationMs=Infinity
    // 预期：mode=study；durationMs=默认 1h（!Number.isFinite → 默认路径）
    expect(start({ mode: 'study', durationMs: Number.POSITIVE_INFINITY }).mode).toBe('study')
    expect(start({ mode: 'study', durationMs: Number.POSITIVE_INFINITY }).timer.durationMs).toBe(
      60 * 60_000
    )
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

  it('stop 手动结束：计时器回 idle，落库用停止前的已学时长', () => {
    // 输入：计划 1h，实际走 90s 后手动结束
    // 预期：界面快照 elapsed 清零；统计与会话结算仍是 90_000（回归 stop 清零导致记 0）
    start({ mode: 'english', durationMs: 60 * 60_000 })
    advance(90_000)
    const result = stop()
    expect(result.timer.status).toBe('idle')
    expect(result.timer.elapsedMs).toBe(0)
    expect(mockDb.recordStudyStats).toHaveBeenCalledWith('2026-01-01', 'english', 90_000, 1)
    expect(mockDb.recordSessionEnd).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        durationActual: 90_000,
        pomosCompleted: 1,
        interruptions: 0,
        status: 'done'
      })
    )
    expect(mockLockScreen.releaseLevelWindow).toHaveBeenCalled()
  })

  it('不足 1 分钟手动结束：时长记实际毫秒，状态为 abandoned', () => {
    start({ mode: 'english', durationMs: 60 * 60_000 })
    advance(30_000)
    stop()
    expect(mockDb.recordSessionEnd).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        durationActual: 30_000,
        pomosCompleted: 0,
        status: 'abandoned'
      })
    )
  })

  it('暂停后再结束：记账用冻结时长，不含暂停期间流逝', () => {
    start({ mode: 'english', durationMs: 60 * 60_000 })
    advance(70_000)
    handlers.get(IPC_CHANNELS.session.pause)!({})
    advance(20_000)
    stop()
    expect(mockDb.recordStudyStats).toHaveBeenCalledWith('2026-01-01', 'english', 70_000, 1)
    expect(mockDb.recordSessionEnd).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ durationActual: 70_000, pomosCompleted: 1, status: 'done' })
    )
  })

  it('idle 下重复 stop：不再落库（幂等异常路径）', () => {
    // 输入：未 start 直接 stop
    // 预期：不调用 recordStudyStats / recordSessionEnd
    stop()
    expect(mockDb.recordStudyStats).not.toHaveBeenCalled()
    expect(mockDb.recordSessionEnd).not.toHaveBeenCalled()
  })

  it('到点完成：落库 done、解除遮罩；bili 模式关闭视频窗口', () => {
    // 输入：bili 会话 1s，单调时钟与 interval 同步推进到点
    // 预期：complete 落库 status=done、closeVideo、release overlay（回归到点路径）
    start({ mode: 'bili', durationMs: 1_000 })
    expect(mockLockScreen.applyLevelWindow).toHaveBeenCalled()
    advance(1_000)
    expect(mockDb.recordSessionEnd).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ status: 'done', pomosCompleted: 1 })
    )
    expect(mockBiliWindow.closeVideo).toHaveBeenCalled()
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

  it('视频窗口已打开时 start 不施加主窗口遮罩', () => {
    // 输入：getVideoState().open=true
    // 预期：不 apply（视频全屏锁定接管，回归防双重遮罩）
    mockBiliWindow.getVideoState.mockReturnValue({
      open: true,
      fullscreen: true,
      autoFullscreen: true
    })
    start({ mode: 'bili', durationMs: 60_000 })
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
