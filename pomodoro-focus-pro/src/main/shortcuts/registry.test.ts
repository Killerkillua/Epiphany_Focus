import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))
vi.mock('../storage/settings', () => ({
  getSettings: vi.fn(() => ({ hotkeys: { volumeUp: 'CommandOrControl+Shift+Up', volumeDown: 'CommandOrControl+Shift+Down', overlayToggle: 'CommandOrControl+Shift+O', closeVideo: 'CommandOrControl+Shift+Q' } })),
  setSettings: vi.fn()
}))
vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

import {
  __setShortcutBackend,
  getShortcutStatus,
  registerShortcut,
  setShortcutAccelerator,
  unregisterShortcut
} from './registry'

let failAcc = ''
const registered = new Map<string, () => void>()

beforeEach(() => {
  failAcc = ''
  registered.clear()
  // 清空上一用例条目
  for (const e of getShortcutStatus()) unregisterShortcut(e.id)
  __setShortcutBackend({
    register: (acc, cb) => {
      if (acc === failAcc) return false
      registered.set(acc, cb)
      return true
    },
    unregister: (acc) => { registered.delete(acc) }
  })
})

describe('快捷键统一注册表', () => {
  it('register 返回 false 时状态上报 ok=false 且带占用原因（不抛错）', () => {
    failAcc = 'CommandOrControl+Shift+Up'
    const ok = registerShortcut({ id: 'volumeUp', label: '音量 +', accelerator: failAcc, scope: 'volume', customizable: true, callback: () => undefined })
    expect(ok).toBe(false)
    const entry = getShortcutStatus().find((e) => e.id === 'volumeUp')!
    expect(entry.ok).toBe(false)
    expect(entry.reason).toContain('占用')
  })

  it('改键失败回滚旧键', () => {
    registerShortcut({ id: 'volumeUp', label: '音量 +', accelerator: 'CommandOrControl+Shift+Up', scope: 'volume', customizable: true, callback: () => undefined })
    failAcc = 'CommandOrControl+Shift+X'
    const res = setShortcutAccelerator('volumeUp', failAcc)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('已恢复原快捷键')
    const entry = getShortcutStatus().find((e) => e.id === 'volumeUp')!
    expect(entry.accelerator).toBe('CommandOrControl+Shift+Up')
    expect(entry.ok).toBe(true)
    expect(registered.has('CommandOrControl+Shift+Up')).toBe(true)
  })

  it('改键成功、拦截键不可改、重复键拒绝', () => {
    registerShortcut({ id: 'volumeUp', label: '音量 +', accelerator: 'CommandOrControl+Shift+Up', scope: 'volume', customizable: true, callback: () => undefined })
    registerShortcut({ id: 'guard:F11', label: '拦截 F11', accelerator: 'F11', scope: 'guard', customizable: false, callback: () => undefined })
    expect(setShortcutAccelerator('volumeUp', 'CommandOrControl+Shift+V').ok).toBe(true)
    expect(getShortcutStatus().find((e) => e.id === 'volumeUp')!.accelerator).toBe('CommandOrControl+Shift+V')
    expect(setShortcutAccelerator('guard:F11', 'F12').ok).toBe(false)
    expect(setShortcutAccelerator('volumeUp', 'F11').ok).toBe(false)
    expect(setShortcutAccelerator('volumeUp', 'bad key!').ok).toBe(false)
  })
})
