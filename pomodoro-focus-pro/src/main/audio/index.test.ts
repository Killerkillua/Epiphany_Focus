import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc'
import { SAMPLE_ASSET_SPECS } from '../../shared/audio'
import type { AssetInfo } from '../../shared/audio'

/**
 * 白噪音主进程模块测试（采样素材解析，方案 2.8）。
 * 纯逻辑：resolveAssetInfos 的 OGG > MP3 > WAV 兜底解析 + 存在性 + tomato-audio:// URL。
 * 经 registerAudioModule 注册的 audio:get-assets IPC 通道触发，无需导出内部函数。
 * app.getAppPath 指向临时目录，可精确控制素材文件存在性。
 * 注意：audioDir() = app.getAppPath()/resources/audio，故素材须写入该子目录。
 */

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(), on: vi.fn() },
  globalShortcut: { register: vi.fn(() => true), unregisterAll: vi.fn() },
  protocol: { handle: vi.fn() },
  ipcMain: { handle: vi.fn() }
}))

import { app, globalShortcut, ipcMain } from 'electron'
import { registerAudioModule } from './index'

let dir: string
/** 素材目录：app.getAppPath()/resources/audio */
let assetsDir: string
let getAssets: () => AssetInfo[]

function register(): void {
  ;(app.getAppPath as ReturnType<typeof vi.fn>).mockReturnValue(dir)
  registerAudioModule(() => null)
  const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>
  const entry = handleMock.mock.calls.find(([ch]) => ch === IPC_CHANNELS.audio.getAssets)
  getAssets = entry![1] as () => AssetInfo[]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pomodoro-audio-'))
  assetsDir = join(dir, 'resources', 'audio')
  mkdirSync(assetsDir, { recursive: true })
  vi.clearAllMocks()
  register()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('audio:get-assets（素材解析）', () => {
  it('空目录：8 个素材全部 exists=false、url 缺省、path 回退 spec.file', () => {
    const assets = getAssets()
    expect(assets).toHaveLength(SAMPLE_ASSET_SPECS.length)
    for (const a of assets) {
      const spec = SAMPLE_ASSET_SPECS.find((s) => s.key === a.key)!
      expect(a.exists, a.key).toBe(false)
      expect(a.url, a.key).toBeUndefined()
      expect(a.path, a.key).toBe(join(assetsDir, spec.file))
      // 规格字段原样透传（渲染层预设组合依赖 volumeHint）
      expect(a.volumeHint).toBe(spec.volumeHint)
      expect(a.label).toBe(spec.label)
    }
  })

  it('存在 rain.mp3：rain 可用且 url=tomato-audio://rain.mp3，其余仍不可用', () => {
    writeFileSync(join(assetsDir, 'rain.mp3'), 'x')
    const assets = getAssets()
    const rain = assets.find((a) => a.key === 'rain')!
    expect(rain.exists).toBe(true)
    expect(rain.url).toBe('tomato-audio://rain.mp3')
    expect(rain.path).toBe(join(assetsDir, 'rain.mp3'))
    for (const a of assets) {
      if (a.key !== 'rain') expect(a.exists, a.key).toBe(false)
    }
  })

  it('OGG > MP3 > WAV 兜底：同素材同时存在 ogg 与 mp3 时优先 ogg', () => {
    writeFileSync(join(assetsDir, 'rain.mp3'), 'x')
    writeFileSync(join(assetsDir, 'rain.ogg'), 'x')
    const rain = getAssets().find((a) => a.key === 'rain')!
    expect(rain.path).toBe(join(assetsDir, 'rain.ogg'))
    expect(rain.url).toBe('tomato-audio://rain.ogg')
  })

  it('WAV 素材（library）按 spec 文件名解析', () => {
    writeFileSync(join(assetsDir, 'library.wav'), 'x')
    const library = getAssets().find((a) => a.key === 'library')!
    expect(library.exists).toBe(true)
    expect(library.url).toBe('tomato-audio://library.wav')
  })
})

describe('全局音量热键注册', () => {
  it('注册 Ctrl+Shift+↑/↓ 两个热键', () => {
    const calls = (globalShortcut.register as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls).toEqual(['CommandOrControl+Shift+Up', 'CommandOrControl+Shift+Down'])
  })

  it('注册失败仅告警不抛错（热键被占用降级）', () => {
    ;(globalShortcut.register as ReturnType<typeof vi.fn>).mockReturnValue(false)
    expect(() => register()).not.toThrow()
  })
})
