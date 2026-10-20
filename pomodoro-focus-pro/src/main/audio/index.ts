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
 * 统一优先走 app.getAppPath()，并在打包/多环境时进行兜底探测：
 * - 开发 = 工程根/resources/audio
 * - 生产 = app.asar/resources/audio（asar 对 asarUnpack 文件透明重定向到
 *   app.asar.unpacked/resources/audio，fs 读取自动生效）
 */
function audioDir(): string {
  const candidates = [
    join(app.getAppPath(), 'resources', 'audio'),
    join(__dirname, '../../resources', 'audio'),
    join(process.cwd(), 'resources', 'audio'),
    join(process.cwd(), 'pomodoro-focus-pro', 'resources', 'audio'),
    ...(process.resourcesPath
      ? [
          join(process.resourcesPath, 'resources', 'audio'),
          join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'audio')
        ]
      : [])
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

/** 解析 8 个采样素材的路径与存在性。MP3 > OGG > WAV 兜底（优先使用 MP3）。 */
function resolveAssetInfos(): AssetInfo[] {
  const dir = audioDir()
  return SAMPLE_ASSET_SPECS.map((spec) => {
    const base = spec.file.replace(/\.(ogg|mp3|wav)$/, '')
    const candidates = [
      join(dir, `${base}.mp3`),
      join(dir, `${base}.ogg`),
      join(dir, `${base}.wav`)
    ]
    const file = candidates.find((f) => existsSync(f)) ?? join(dir, spec.file)
    const exists = existsSync(file)
    const fileName = basename(file)
    return {
      ...spec,
      path: file,
      exists,
      // 渲染层可 fetch 的 URL（tomato-audio://audio/${fileName} 标准结构）
      url: exists ? `tomato-audio://audio/${fileName}` : undefined
    }
  })
}

/** 按扩展名推断 MIME（decodeAudioData 依赖嗅探，此处仅为规范） */
function mimeOf(fileName: string): string {
  if (fileName.endsWith('.mp3')) return 'audio/mpeg'
  if (fileName.endsWith('.wav')) return 'audio/wav'
  return 'audio/ogg'
}

function extractAudioFileName(urlStr: string): string {
  try {
    const parsed = new URL(urlStr)
    const pathPart = decodeURIComponent(parsed.pathname || '').replace(/^\/+|\/+$/g, '')
    if (pathPart && /\.(mp3|ogg|wav)$/i.test(pathPart)) {
      return basename(pathPart)
    }
    const hostPart = decodeURIComponent(parsed.hostname || '')
    if (hostPart && /\.(mp3|ogg|wav)$/i.test(hostPart)) {
      return basename(hostPart)
    }
    const clean = urlStr.split('?')[0].split('#')[0]
    return basename(decodeURIComponent(clean))
  } catch {
    return basename(decodeURIComponent(urlStr))
  }
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
    try {
      const fileName = extractAudioFileName(request.url)
      if (!fileName || fileName.includes('..')) {
        return new Response(new Uint8Array(), { status: 400 })
      }

      const full = join(audioDir(), fileName)
      if (!existsSync(full)) {
        return new Response(new Uint8Array(), { status: 404 })
      }

      // 直接读文件构造响应（素材 ≤5MB，无需流式）；
      // 显式带 ACAO 和 Content-Length 头，确保流与 CORS 绝对畅通
      const data = readFileSync(full)
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': mimeOf(fileName),
          'Content-Length': String(data.byteLength),
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (err) {
      console.error('[audio] 自定义协议处理失败:', err)
      return new Response(new Uint8Array(), { status: 500 })
    }
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

  // ---- 3. 二进制数据直接读取（IPC 兜底通道） ----
  ipcMain.handle(IPC_CHANNELS.audio.getBuffer, (_event, fileNameOrKey: string): Uint8Array | null => {
    try {
      const dir = audioDir()
      const key = fileNameOrKey.replace(/\.(mp3|ogg|wav)$/, '')
      const candidates = [
        join(dir, `${key}.mp3`),
        join(dir, `${key}.ogg`),
        join(dir, `${key}.wav`),
        join(dir, fileNameOrKey)
      ]
      const file = candidates.find((f) => existsSync(f))
      if (!file) return null
      return new Uint8Array(readFileSync(file))
    } catch {
      return null
    }
  })

  // ---- 4. 退出注销全局热键 ----
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
