import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/electron-userData' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: undefined,
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  changePassword,
  deleteAccount,
  verifyCurrentPassword,
  generateRecoveryCode,
  getAuthState,
  getCurrentDbFile,
  initAuth,
  login,
  loginGuest,
  logout,
  register,
  resetAuthForTest,
  resetPassword,
  updateNickname
} from './index'
import { closeDb } from '../storage/db'
import { validatePassword, validateUsername } from '../../shared/auth'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pomodoro-auth-'))
  process.env.POMODORO_AUTH_DB_PATH = join(dir, 'auth.db')
  process.env.POMODORO_AUTH_TOKEN_PATH = join(dir, 'token.bin')
  process.env.POMODORO_DB_PATH = join(dir, 'biz.db')
  process.env.POMODORO_DB_DRIVER = 'node:sqlite'
  resetAuthForTest()
  closeDb()
})

afterEach(() => {
  resetAuthForTest()
  closeDb()
  for (const k of [
    'POMODORO_AUTH_DB_PATH',
    'POMODORO_AUTH_TOKEN_PATH',
    'POMODORO_DB_PATH',
    'POMODORO_DB_DRIVER'
  ]) {
    delete process.env[k]
  }
  rmSync(dir, { recursive: true, force: true })
})

const PWD = 'abc12345'

describe('输入校验', () => {
  it('用户名与密码规则', () => {
    expect(validateUsername('ab')).not.toBeNull()
    expect(validateUsername('bad name!')).not.toBeNull()
    expect(validateUsername('小明_01')).toBeNull()
    expect(validatePassword('short1')).not.toBeNull()
    expect(validatePassword('onlyletters')).not.toBeNull()
    expect(validatePassword('abc12345')).toBeNull()
  })
})

describe('注册 / 登录', () => {
  it('首个账号接管旧数据库文件，第二个账号使用独立文件', async () => {
    const a = await register({ username: 'alice', password: PWD })
    expect(a.ok).toBe(true)
    expect(getCurrentDbFile()).toBe('pomodoro.db')
    logout()
    const b = await register({ username: 'bob', password: PWD })
    expect(b.ok && getCurrentDbFile()).toMatch(/^user-\d+\.db$/)
  })

  it('用户名不区分大小写且不可重复', async () => {
    await register({ username: 'Alice', password: PWD })
    const dup = await register({ username: 'alice', password: PWD })
    expect(dup.ok).toBe(false)
  })

  it('注册返回格式正确的恢复码，且默认昵称为用户名', async () => {
    const r = await register({ username: 'alice', password: PWD })
    if (!r.ok) throw new Error('register failed')
    expect(r.recoveryCode).toMatch(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/)
    expect(r.user.nickname).toBe('alice')
  })

  it('错误密码与不存在的用户返回相同提示', async () => {
    await register({ username: 'alice', password: PWD })
    logout()
    const wrong = await login({ username: 'alice', password: 'wrong1234', remember: false })
    const none = await login({ username: 'nobody', password: PWD, remember: false })
    expect(wrong.ok).toBe(false)
    expect(none.ok).toBe(false)
    if (!wrong.ok && !none.ok) expect(wrong.error.startsWith('用户名或密码错误')).toBe(true)
    expect(getAuthState().status).toBe('loggedOut')
  })

  it('连续失败 5 次后锁定，即使密码正确也被拒绝', async () => {
    await register({ username: 'alice', password: PWD })
    logout()
    for (let i = 0; i < 5; i++) {
      await login({ username: 'alice', password: 'wrong1234', remember: false })
    }
    const locked = await login({ username: 'alice', password: PWD, remember: false })
    expect(locked.ok).toBe(false)
    if (!locked.ok) expect(locked.retryInSec).toBeGreaterThan(0)
  })
})

describe('自动登录', () => {
  it('勾选记住我后重启可自动登录；登出后失效', async () => {
    await register({ username: 'alice', password: PWD })
    logout()
    await login({ username: 'alice', password: PWD, remember: true })
    // 模拟重启：清内存状态，保留 auth.db 与令牌文件
    const state = getAuthState()
    expect(state.status).toBe('user')
    const keepDb = process.env.POMODORO_AUTH_DB_PATH
    resetAuthForTest()
    process.env.POMODORO_AUTH_DB_PATH = keepDb
    expect(initAuth().status).toBe('user')
    logout()
    resetAuthForTest()
    expect(initAuth().status).toBe('loggedOut')
  })

  it('未勾选记住我则重启后需重新登录', async () => {
    await register({ username: 'alice', password: PWD })
    logout()
    await login({ username: 'alice', password: PWD, remember: false })
    resetAuthForTest()
    expect(initAuth().status).toBe('loggedOut')
  })
})

describe('游客与账号管理', () => {
  it('游客使用独立 guest.db', () => {
    loginGuest()
    expect(getAuthState().status).toBe('guest')
    expect(getCurrentDbFile()).toBe('guest.db')
  })

  it('修改紧急恢复码前校验当前账户密码', async () => {
    expect((await verifyCurrentPassword(PWD)).ok).toBe(false)
    await register({ username: 'alice', password: PWD })
    const wrong = await verifyCurrentPassword('wrong1234')
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toContain('密码')
    expect((await verifyCurrentPassword(PWD)).ok).toBe(true)
    loginGuest()
    const guest = await verifyCurrentPassword(PWD)
    expect(guest.ok).toBe(false)
    if (!guest.ok) expect(guest.error).toContain('登录')
  })

  it('修改密码需原密码，新密码生效', async () => {
    await register({ username: 'alice', password: PWD })
    expect((await changePassword('wrong1234', 'newpass99')).ok).toBe(false)
    expect((await changePassword(PWD, 'newpass99')).ok).toBe(true)
    logout()
    expect((await login({ username: 'alice', password: PWD, remember: false })).ok).toBe(false)
    expect((await login({ username: 'alice', password: 'newpass99', remember: false })).ok).toBe(
      true
    )
  })

  it('修改昵称；留空回退为用户名', async () => {
    await register({ username: 'alice', password: PWD })
    const r = updateNickname('小A')
    expect(r.ok && r.user.nickname).toBe('小A')
    const r2 = updateNickname('  ')
    expect(r2.ok && r2.user.nickname).toBe('alice')
  })

  it('注销账号需密码，之后无法登录', async () => {
    await register({ username: 'alice', password: PWD })
    expect((await deleteAccount({ password: 'wrong1234', deleteData: false })).ok).toBe(false)
    expect((await deleteAccount({ password: PWD, deleteData: false })).ok).toBe(true)
    expect(getAuthState().status).toBe('loggedOut')
    expect((await login({ username: 'alice', password: PWD, remember: false })).ok).toBe(false)
  })
})

describe('恢复码重置密码', () => {
  it('正确恢复码可重置，且恢复码轮换（旧码作废）', async () => {
    const r = await register({ username: 'alice', password: PWD })
    if (!r.ok) throw new Error('register failed')
    logout()

    const bad = await resetPassword({
      username: 'alice',
      recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
      newPassword: 'brandnew88'
    })
    expect(bad.ok).toBe(false)

    const ok = await resetPassword({
      username: 'alice',
      recoveryCode: r.recoveryCode.toLowerCase(), // 大小写不敏感
      newPassword: 'brandnew88'
    })
    if (!ok.ok) throw new Error('reset failed')
    expect(ok.recoveryCode).not.toBe(r.recoveryCode)

    const old = await resetPassword({
      username: 'alice',
      recoveryCode: r.recoveryCode,
      newPassword: 'another999'
    })
    expect(old.ok).toBe(false)
    expect((await login({ username: 'alice', password: 'brandnew88', remember: false })).ok).toBe(
      true
    )
  })

  it('恢复码长度与字符集', () => {
    for (let i = 0; i < 20; i++) expect(generateRecoveryCode()).toMatch(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/)
  })
})
