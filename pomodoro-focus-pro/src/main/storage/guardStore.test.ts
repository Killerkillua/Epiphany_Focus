import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __resetGuardStoreForTests,
  readGuarded,
  wasTamperDetected,
  writeGuarded
} from './guardStore'

let dir: string
const legacy = (): Record<string, unknown> => ({ recoveryCodeHash: 'legacy-hash', enforced: null })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-'))
  process.env.POMODORO_SETTINGS_CWD = dir
  __resetGuardStoreForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  delete process.env.POMODORO_SETTINGS_CWD
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('guardStore（HMAC 完整性）', () => {
  it('首次启用：迁移旧值并签名', () => {
    expect(readGuarded(legacy).recoveryCodeHash).toBe('legacy-hash')
    expect(wasTamperDetected()).toBe(false)
  })

  it('写入后可读回（冷启动，无内存缓存）', () => {
    writeGuarded({ lockLevel: 'L2' }, legacy)
    __resetGuardStoreForTests()
    expect(readGuarded(legacy).lockLevel).toBe('L2')
    expect(wasTamperDetected()).toBe(false)
  })

  it('运行期手改 guard.json：被内存副本自愈覆盖', () => {
    writeGuarded({ recoveryCodeHash: 'real-hash' }, legacy)
    const p = join(dir, 'guard.json')
    const f = JSON.parse(readFileSync(p, 'utf8'))
    f.payload = f.payload.replace('real-hash', 'attacker-hash')
    writeFileSync(p, JSON.stringify(f))
    expect(readGuarded(legacy).recoveryCodeHash).toBe('real-hash')
    expect(wasTamperDetected()).toBe(true)
    // 自愈后文件重新合法
    __resetGuardStoreForTests()
    expect(readGuarded(legacy).recoveryCodeHash).toBe('real-hash')
    expect(wasTamperDetected()).toBe(false)
  })

  it('离线手改 guard.json 后冷启动：从已验签的 guard.bak 恢复，强制状态保留', () => {
    writeGuarded({ recoveryCodeHash: 'real-hash', enforced: { active: true } }, legacy)
    const p = join(dir, 'guard.json')
    const f = JSON.parse(readFileSync(p, 'utf8'))
    f.payload = f.payload.replace('real-hash', 'attacker-hash')
    writeFileSync(p, JSON.stringify(f))
    __resetGuardStoreForTests()
    const r = readGuarded(legacy)
    expect(r.recoveryCodeHash).toBe('real-hash')
    expect(r.enforced).toEqual({ active: true })
    expect(wasTamperDetected()).toBe(true)
  })

  it('离线删除 guard.json 后冷启动：从 guard.bak 恢复而不是解除强制', () => {
    writeGuarded({ lockLevel: 'L2', enforced: { active: true } }, legacy)
    rmSync(join(dir, 'guard.json'))
    __resetGuardStoreForTests()
    const r = readGuarded(legacy)
    expect(r.lockLevel).toBe('L2')
    expect(r.enforced).toEqual({ active: true })
    expect(wasTamperDetected()).toBe(true)
  })

  it('guard.json 与 guard.bak 同时被破坏：fail-safe 重置为无强制、无恢复码', () => {
    writeGuarded({ recoveryCodeHash: 'real-hash', enforced: { active: true } }, legacy)
    rmSync(join(dir, 'guard.json'))
    writeFileSync(join(dir, 'guard.bak'), 'garbage')
    __resetGuardStoreForTests()
    const r = readGuarded(legacy)
    expect(r.recoveryCodeHash).toBeNull()
    expect(r.enforced).toBeNull()
    expect(wasTamperDetected()).toBe(true)
  })

  it('重新签名但密钥不对（攻击者自带密钥）无效', () => {
    writeGuarded({ recoveryCodeHash: 'real-hash' }, legacy)
    // 伪造：用任意密钥给篡改后的负载签名
    const payload = JSON.stringify({ recoveryCodeHash: 'attacker-hash' })
    writeFileSync(join(dir, 'guard.json'), JSON.stringify({ payload, sig: 'ab'.repeat(32) }))
    expect(readGuarded(legacy).recoveryCodeHash).toBe('real-hash')
    expect(wasTamperDetected()).toBe(true)
  })
})
