import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'

/**
 * 专注手动结束落库：stop() 会把 elapsed 清零，统计必须用停止前的时长。
 * Electron 与强制副作用全部 mock，计时仍走真实 TimerService。
 */

const mockDb = vi.hoisted(() => ({
  recordSessionStart: vi.fn(() => 7),
  recordSessionEnd: vi.fn(),
  recordStudyStats: vi.fn(),
  todayLocal: vi.fn(() => '2026-01-01')
}))

const mockSettings = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({ lockLevel: 'L0', endAction: 'notify' })),
  setSettings: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/pomodoro-test' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../storage/db', () => mockDb)
vi.mock('../storage/settings', () => mockSettings)
vi.mock('../storage/taskRepository', () => ({
  addInterruption: vi.fn(),
  creditFocusPomodoro: vi.fn(),
  getFocusSessionContext: vi.fn(() => null),
  getTask: vi.fn(),
  updateInterruptionNote: vi.fn()
}))
vi.mock('../auth', () => ({ verifyCurrentPassword: vi.fn() }))
vi.mock('./emergencyExit', () => ({
  capToSessionMax: (ms: number) => ms,
  assertExitSafety: () => {},
  isSessionExpired: () => false,
  sessionMaxMs: () => 4 * 3_600_000,
  startL2CoolDown: vi.fn(),
  verifyRecoveryCode: vi.fn(),
  validateRecoveryCode: () => null,
  hasRecoveryCode: () => false,
  setRecoveryCode: vi.fn()
}))
vi.mock('./shortcutGuard', () => ({
  registerShortcutGuard: vi.fn(),
  unregisterShortcutGuard: vi.fn()
}))
vi.mock('./windowGuard', () => ({
  WindowGuard: class {
    start(): void {}
    stop(): void {}
    setPaused(): void {}
  }
}))
vi.mock('./processGuard', () => ({
  startTaskmgrKill: vi.fn(),
  stopTaskmgrKill: vi.fn()
}))
vi.mock('./guardianLaunch', () => ({
  planGuardianSpawn: vi.fn(),
  spawnGuardianProcess: vi.fn()
}))
vi.mock('./sessionCap', () => ({
  createSessionCapWatch: () => ({ arm: vi.fn(), clear: vi.fn() })
}))
vi.mock('./lockScreen', () => ({
  applyLevelWindow: vi.fn(),
  releaseLevelWindow: vi.fn(),
  lockWorkstation: vi.fn()
}))
vi.mock('../notify', () => ({ showAppNotification: vi.fn() }))

let handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
let nowMs = 0

function advance(ms: number): void {
  nowMs += ms
  vi.advanceTimersByTime(ms)
}

function fakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    setAlwaysOnTop: vi.fn(),
    webContents: { send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
  } as unknown as BrowserWindow
}

beforeEach(async () => {
  vi.useFakeTimers()
  nowMs = 0
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => BigInt(nowMs * 1_000_000))
  vi.resetModules()
  mockDb.recordSessionStart.mockReset().mockReturnValue(7)
  mockDb.recordSessionEnd.mockReset()
  mockDb.recordStudyStats.mockReset()
  mockDb.todayLocal.mockReset().mockReturnValue('2026-01-01')
  mockSettings.getSettings.mockReset().mockReturnValue({ lockLevel: 'L0', endAction: 'notify' })
  mockSettings.setSettings.mockReset()

  const electron = (await import('electron')) as unknown as {
    ipcMain: { handle: ReturnType<typeof vi.fn> }
  }
  electron.ipcMain.handle.mockClear()
  const { registerEnforcementModule } = await import('./index')
  registerEnforcementModule(() => fakeWindow())
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

describe('专注手动结束落库', () => {
  it('倒计时放弃：durationActual 是停止前已学时长，状态 abandoned', () => {
    // 输入：L0 倒计时 10 分钟，走 90 秒后 timer:stop
    // 预期：会话结算 durationActual=90000、abandoned；界面返回值 elapsed 已清零
    handlers.get(IPC_CHANNELS.timer.start)!({}, { mode: 'countdown', durationMs: 10 * 60_000 })
    advance(90_000)
    const snap = handlers.get(IPC_CHANNELS.timer.stop)!({}) as { elapsedMs: number; status: string }
    expect(snap.status).toBe('idle')
    expect(snap.elapsedMs).toBe(0)
    expect(mockDb.recordSessionEnd).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        durationActual: 90_000,
        pomosCompleted: 0,
        status: 'abandoned'
      })
    )
  })

  it('正序超过 5 秒结束：统计与会话时长都是停止前的 elapsed', () => {
    // 输入：countup 走 6 秒后停止
    // 预期：study_stats 与 durationActual 都是 6000，状态 done
    handlers.get(IPC_CHANNELS.timer.start)!({}, { mode: 'countup', durationMs: 60 * 60_000 })
    advance(6_000)
    handlers.get(IPC_CHANNELS.timer.stop)!({})
    expect(mockDb.recordStudyStats).toHaveBeenCalledWith('2026-01-01', 'focus', 6_000, 1)
    expect(mockDb.recordSessionEnd).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ durationActual: 6_000, status: 'done' })
    )
  })
})
