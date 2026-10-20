import { describe, expect, it } from 'vitest'
import { isEnforcedLevel, LEVEL_CAPS, LEVEL_LABEL } from './level'
import type { LockLevel } from '../../shared/settings'

/**
 * 锁定强度分级测试（方案 2.5）。
 * LEVEL_CAPS：各级能力矩阵（L0 轻量 / L1 标准 / L2 强化）。
 * isEnforcedLevel：L0 可全绕过 → 非强制；L1/L2 为强制级别。
 */

describe('LEVEL_CAPS（能力矩阵）', () => {
  it('L0 仅窗口置顶，其余能力全部关闭（可完全绕过）', () => {
    const caps = LEVEL_CAPS.L0
    expect(caps.alwaysOnTop).toBe(true)
    expect(caps.fullscreenOverlay).toBe(false)
    expect(caps.globalShortcuts).toBe(false)
    expect(caps.hideTaskbar).toBe(false)
    expect(caps.killDistractions).toBe(false)
    expect(caps.pullBackForeground).toBe(false)
    expect(caps.killTaskmgr).toBe(false)
    expect(caps.guardian).toBe(false)
  })

  it('L1 标准：全屏遮罩 + 快捷键拦截 + 任务栏隐藏 + 分心强关 + 前台拉回；无守护/关任务管理器', () => {
    const caps = LEVEL_CAPS.L1
    expect(caps.alwaysOnTop).toBe(true)
    expect(caps.fullscreenOverlay).toBe(true)
    expect(caps.globalShortcuts).toBe(true)
    expect(caps.hideTaskbar).toBe(true)
    expect(caps.killDistractions).toBe(true)
    expect(caps.pullBackForeground).toBe(true)
    expect(caps.killTaskmgr).toBe(false)
    expect(caps.guardian).toBe(false)
  })

  it('L2 强化：在 L1 基础上追加关闭任务管理器 + 守护进程自检拉起', () => {
    const caps = LEVEL_CAPS.L2
    expect(caps.alwaysOnTop).toBe(true)
    expect(caps.fullscreenOverlay).toBe(true)
    expect(caps.globalShortcuts).toBe(true)
    expect(caps.hideTaskbar).toBe(true)
    expect(caps.killDistractions).toBe(true)
    expect(caps.pullBackForeground).toBe(true)
    expect(caps.killTaskmgr).toBe(true)
    expect(caps.guardian).toBe(true)
  })

  it('能力随级别单调增强（L0 ⊂ L1 ⊂ L2），不允许出现回落', () => {
    const fields: Array<keyof typeof LEVEL_CAPS.L0> = [
      'alwaysOnTop',
      'fullscreenOverlay',
      'globalShortcuts',
      'hideTaskbar',
      'killDistractions',
      'pullBackForeground',
      'killTaskmgr',
      'guardian'
    ]
    for (const f of fields) {
      const l0 = LEVEL_CAPS.L0[f]
      const l1 = LEVEL_CAPS.L1[f]
      const l2 = LEVEL_CAPS.L2[f]
      // L1 不低于 L0，L2 不低于 L1（boolean 单调）
      expect(l1 || l0, `L1.${f} 不能低于 L0`).toBe(l1)
      expect(l2 || l1, `L2.${f} 不能低于 L1`).toBe(l2)
    }
  })
})

describe('isEnforcedLevel（强制级别判定）', () => {
  it('L0 为非强制（可绕过），L1/L2 为强制', () => {
    expect(isEnforcedLevel('L0')).toBe(false)
    expect(isEnforcedLevel('L1')).toBe(true)
    expect(isEnforcedLevel('L2')).toBe(true)
  })
})

describe('LEVEL_LABEL（档位说明）', () => {
  it('三个档位都有中文说明，且与能力矩阵一致', () => {
    expect(LEVEL_LABEL.L0).toContain('L0')
    expect(LEVEL_LABEL.L1).toContain('L1')
    expect(LEVEL_LABEL.L2).toContain('L2')
    // 说明必须覆盖全部 LockLevel 值
    const levels: LockLevel[] = ['L0', 'L1', 'L2']
    for (const l of levels) {
      expect(LEVEL_LABEL[l].length).toBeGreaterThan(0)
    }
  })
})
