import { app, globalShortcut, ipcMain, protocol, net } from 'electron'
import type { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC_CHANNELS, IPC_EVENTS } from '../ipc'
import { HOTKEY_VOLUME_STEP, SAMPLE_ASSET_SPECS } from '../../shared/audio'
import type { AssetInfo } from '../../shared/audio'

/**
 * 白噪音主进程支持（M1 核心版 + 采样素材协议）。
 * 说明：Web Audio 混音引擎位于渲染层（src/renderer/src/audio/），
 * 主进程负责四件事：
 * 1. 盲操作热键 Ctrl+Shift+↑/↓（globalShortcut，全局生效）→ 转发音量事件给渲染层
 * 2. 采样素材绝对路径解析（resources/audio/，打包随 asarUnpack 外置）
 * 3. tomato-audio:// 自定义协议（渲染层 fetch 采样文件用）
 * 4. 退出时注销热键
 */

/** resources/audio/ 目录（开发 = 工程根/resources/audio；生产 = process.resourcesPath/audio） */
function audioDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'audio')
    : join(app.getAppPath(), 'resources', 'audio')
}

/** 解析 8 个采样素材的路径与存在性。OGG 优先，WAV 兜底（兼顾无 ffmpeg 环境）。 */
function resolveAssetInfos(): AssetInfo[] {
  const dir = audioDir()
  return SAMPLE_ASSET_SPECS.map((spec) => {
    const ogg = join(dir, spec.file)
    const wav = join(dir, spec.file.replace(/\.ogg$/, '.wav'))
    const file = existsSync(ogg) ? ogg : existsSync(wav) ? wav : ogg
    const exists = existsSync(file)
    const fileName = basename(file)
    return {
      ...spec,
      path: file,
      exists,
      // 渲染层可 fetch 的 URL（tomato-audio:// 自定义协议）
      url: exists ? `tomato-audio://${fileName}` : undefined
    }
  })
}

function registerGlobalHotkey(accelerator: string, label: string, callback: () => void): void {
  const ok = globalShortcut.register(accelerator, callback)
  if (!ok) {
    console.warn(`[audio] 热键注册失败（可能被占用）: ${accelerator}（${label}）`)
  }
}

export function registerAudioModule(getWindow: () => BrowserWindow | null): void {
  // ---- 0. 注册自定义协议处理器（渲染层 fetch 采样文件用） ----
  protocol.handle('tomato-audio', (request) => {
    // URL 格式：tomato-audio://rain.ogg → hostname = 'rain.ogg'
    const fileName = new URL(request.url).hostname
    // 安全：拒绝含路径分隔符的输入，防目录穿越
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      return new Response(new Uint8Array(), { status: 403 })
    }
    const full = join(audioDir(), basename(fileName))
    if (!existsSync(full)) {
      return new Response(new Uint8Array(), { status: 404 })
    }
    return net.fetch(pathToFileURL(full).toString())
  })

  // ---- 1. 盲操作热键：Ctrl+Shift+↑/↓ 调节主音量 ----
  registerGlobalHotkey('CommandOrControl+Shift+Up', '音量 +', () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.audio.volumeChanged, { delta: +HOTKEY_VOLUME_STEP })
    }
  })
  registerGlobalHotkey('CommandOrControl+Shift+Down', '音量 -', () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.audio.volumeChanged, { delta: -HOTKEY_VOLUME_STEP })
    }
  })

  // ---- 2. 采样素材信息（渲染层据此决定采样轨可用性 + fetch URL） ----
  ipcMain.handle(IPC_CHANNELS.audio.getAssets, (): AssetInfo[] => resolveAssetInfos())

  // ---- 3. 退出注销全局热键 ----
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
