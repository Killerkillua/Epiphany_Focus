import { spawn } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
    unref: vi.fn()
  }))
}))

import { startTaskmgrKill, stopTaskmgrKill } from './processGuard'

describe('进程拦截降级', () => {
  afterEach(() => {
    stopTaskmgrKill()
  })

  it('非 Windows 不调用 taskkill', () => {
    const previous = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      startTaskmgrKill()
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      if (previous) Object.defineProperty(process, 'platform', previous)
    }
  })
})
