import { afterEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ spawn }))

import { planGuardianSpawn, spawnGuardianProcess } from './guardianLaunch'

afterEach(() => {
  spawn.mockReset()
})

describe('planGuardianSpawn', () => {
  it('用应用可执行文件启动，并给子进程带上 ELECTRON_RUN_AS_NODE=1', () => {
    const plan = planGuardianSpawn({
      execPath: 'C:\\Program Files\\Epiphany Focus\\静界专注.exe',
      script: 'C:\\Program Files\\Epiphany Focus\\resources\\app.asar\\out\\main\\guardian.js',
      pidFile: 'C:\\Users\\me\\AppData\\Roaming\\app\\enforced.pid',
      relaunchExe: 'C:\\Program Files\\Epiphany Focus\\静界专注.exe',
      relaunchArgs: [],
      secret: 'signed-secret',
      env: { PATH: 'C:\\Windows\\System32', ELECTRON_RUN_AS_NODE: '' }
    })

    expect(plan.command).toBe('C:\\Program Files\\Epiphany Focus\\静界专注.exe')
    expect(plan.command).not.toBe('node')
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(plan.env.POMODORO_GUARDIAN_SECRET).toBe('signed-secret')
    expect(plan.env.PATH).toBe('C:\\Windows\\System32')
    expect(plan.args.slice(0, 6)).toEqual([
      'C:\\Program Files\\Epiphany Focus\\resources\\app.asar\\out\\main\\guardian.js',
      '--watch',
      'C:\\Users\\me\\AppData\\Roaming\\app\\enforced.pid',
      '--kill-taskmgr',
      '--interval',
      '2000'
    ])
  })
})

describe('spawnGuardianProcess', () => {
  it('按计划启动，并监听 error，避免找不到可执行文件时变成未捕获异常', () => {
    const on = vi.fn()
    const unref = vi.fn()
    spawn.mockReturnValue({ on, unref })
    const plan = planGuardianSpawn({
      execPath: '/Applications/Epiphany Focus.app/Contents/MacOS/Epiphany Focus',
      script: '/guardian.js',
      pidFile: '/tmp/enforced.pid',
      relaunchExe: '/Applications/Epiphany Focus.app/Contents/MacOS/Epiphany Focus',
      relaunchArgs: ['/app'],
      secret: 's',
      env: {}
    })

    spawnGuardianProcess(plan)

    expect(spawn).toHaveBeenCalledWith(plan.command, plan.args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      env: plan.env
    })
    expect(on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(unref).toHaveBeenCalledTimes(1)
  })
})
