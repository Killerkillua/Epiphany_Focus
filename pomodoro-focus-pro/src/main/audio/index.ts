import { app, globalShortcut, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS, IPC_EVENTS } from '../ipc'
import { HOTKEY_VOLUME_STEP, SAMPLE_ASSET_SPECS } from '../../shared/audio'
import type { AssetInfo } from '../../shared/audio'

/**
 * 白噪音主进程支持（M1 核心版）。
 * 说明：Web Audio 混音引擎位于渲染层（src/renderer/src/audio/），
 * 主进程负责三件事：
 * 1. 盲操作热键 Ctrl+Shift+↑/↓（globalShortcut，全局生效）→ 转发音量事件给渲染层
 * 2. 采样素材绝对路径解析（resources/audio/，打包随 asarUnpack 外置）
 * 3. 退出时注销热键
 */

/** resources/audio/ 目录（开发 = 工程根/resources/audio；生产 = process.resourcesPath/audio） */
function audioDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'audio')
    : join(app.getAppPath(), 'resources', 'audio')
}

/** 解析 8 个采样素材的路径与存在性（M1 素材未打包时 exists=false，采样轨自动跳过） */
function resolveAssetInfos(): AssetInfo[] {
  const dir = audioDir()
  return SAMPLE_ASSET_SPECS.map((spec) => {
    const path = join(dir, spec.file)
    return { ...spec, exists: existsSync(path), path }
  })
}

function registerGlobalHotkey(accelerator: string, label: string, callback: () => void): void {
  const ok = globalShortcut.register(accelerator, callback)
  if (!ok) {
    console.warn(`[audio] 热键注册失败（可能被占用）: ${accelerator}（${label}）`)
  }
}

export function registerAudioModule(getWindow: () => BrowserWindow | null): void {
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

  // ---- 2. 采样素材信息（渲染层据此决定采样轨可用性） ----
  ipcMain.handle(IPC_CHANNELS.audio.getAssets, (): AssetInfo[] => resolveAssetInfos())

  // ---- 3. 退出注销全局热键 ----
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
