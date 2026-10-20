import { afterEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() =>
  vi.fn(() => ({
    on: () => undefined,
    unref: () => undefined
  }))
)

vi.mock('child_process', () => ({ spawn }))

import { startTaskmgrKill, stopTaskmgrKill } from './processGuard'

describe('非 Windows 不杀进程', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    if (original) Object.defineProperty(process, 'platform', original)
    spawn.mockClear()
    stopTaskmgrKill()
  })

  it('linux 上 startTaskmgrKill 不 spawn taskkill', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    startTaskmgrKill()
    expect(spawn).not.toHaveBeenCalled()
  })
})
