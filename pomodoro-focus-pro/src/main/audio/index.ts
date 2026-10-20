import { app, globalShortcut, ipcMain, protocol } from 'electron'
import type { BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc'
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

/**
 * resources/audio/ 目录。
 * 统一走 app.getAppPath()：
 * - 开发 = 工程根/resources/audio
 * - 生产 = app.asar/resources/audio（asar 对 asarUnpack 文件透明重定向到
 *   app.asar.unpacked/resources/audio，fs 读取自动生效）
 */
function audioDir(): string {
  return join(app.getAppPath(), 'resources', 'audio')
}

/** 解析 8 个采样素材的路径与存在性。OGG > MP3 > WAV 兜底。 */
function resolveAssetInfos(): AssetInfo[] {
  const dir = audioDir()
  return SAMPLE_ASSET_SPECS.map((spec) => {
    const base = spec.file.replace(/\.(ogg|mp3|wav)$/, '')
    const candidates = [
      join(dir, `${base}.ogg`),
      join(dir, `${base}.mp3`),
      join(dir, `${base}.wav`)
    ]
    const file = candidates.find((f) => existsSync(f)) ?? join(dir, spec.file)
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

/** 按扩展名推断 MIME（decodeAudioData 依赖嗅探，此处仅为规范） */
function mimeOf(fileName: string): string {
  if (fileName.endsWith('.wav')) return 'audio/wav'
  if (fileName.endsWith('.mp3')) return 'audio/mpeg'
  return 'audio/ogg'
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
    // URL 格式：tomato-audio://rain.mp3 → hostname = 'rain.mp3'
    const fileName = basename(new URL(request.url).hostname)
    // 安全：拒绝目录穿越（basename 已清洗，再校验最终路径必须位于 audioDir 内）
    const full = join(audioDir(), fileName)
    if (
      !fileName ||
      fileName !== new URL(request.url).hostname ||
      fileName.includes('..') ||
      !existsSync(full)
    ) {
      return new Response(new Uint8Array(), { status: 404 })
    }
    // 直接读文件构造响应（素材 ≤5MB，无需流式）；
    // 显式带 ACAO 头，兼容当前及未来版本对自定义协议的 CORS 管控
    return new Response(new Uint8Array(readFileSync(full)), {
      status: 200,
      headers: {
        'Content-Type': mimeOf(fileName),
        'Access-Control-Allow-Origin': '*'
      }
    })
  })

  // 启动诊断：素材就绪情况（缺素材时便于排查路径）
  const readyCount = resolveAssetInfos().filter((info) => info.exists).length
  console.info(`[audio] 素材目录 ${audioDir()}，就绪 ${readyCount}/${SAMPLE_ASSET_SPECS.length}`)

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
