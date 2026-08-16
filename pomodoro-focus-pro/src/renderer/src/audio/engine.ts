import { CrossfadeLoop } from './seamlessLoop'
import { createNoiseBuffer } from './synth'
import { loadSettings, saveSettings } from './presets'
import { CROSSFADE_SEC, SYNTH_BUFFER_SEC, getNoisePreset } from '../../../shared/audio'
import type { NoisePreset, NoiseSettings, SampleKind, SyntheticNoiseKind } from '../../../shared/audio'

/**
 * 白噪音混音引擎（渲染层，Web Audio API）。
 *
 * 拓扑（方案 2.8）：每轨 [BufferSource(A/B) → NodeGain(A/B)] → 轨 outGain → MasterGain → destination。
 * - 每轨独立 CrossfadeLoop（双节点交叉淡入淡出无缝循环），轨音量独立可调
 * - MasterGain 统一主音量；休息联动时对 MasterGain 做平滑降音量（duck）或整体停止
 * - 采样轨（雨/咖啡厅/…）经 audio:get-assets 探测可用性，素材未打包时自动跳过
 */

export interface ActiveTrack {
  key: string
  label: string
  volume: number
  loop: CrossfadeLoop
}

export interface PlayResult {
  /** 本次动作：启动播放（start）或停止（stop） */
  action: 'start' | 'stop'
  started: number
  skipped: string[]
}

type Listener = () => void

class NoiseEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private tracks = new Map<string, ActiveTrack>()
  private settings: NoiseSettings = loadSettings()
  private volume = this.settings.volume
  private listeners = new Set<Listener>()
  private assetsCache: Record<string, { exists: boolean; url?: string }> | null = null
  private bufferCache = new Map<string, AudioBuffer>()

  /* ===== 只读状态 ===== */

  get playing(): boolean {
    return this.tracks.size > 0
  }

  get masterVolume(): number {
    return this.volume
  }

  get activeTracks(): ActiveTrack[] {
    return [...this.tracks.values()]
  }

  getSettings(): NoiseSettings {
    return { ...this.settings }
  }

  /* ===== 订阅 ===== */

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /* ===== 上下文 / 主音量 ===== */

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }

  /** 设置主音量（平滑 50ms），持久化 */
  setMasterVolume(value: number): void {
    this.volume = clamp01(value)
    this.settings.volume = this.volume
    saveSettings(this.settings)
    if (this.ctx && this.master) {
      const now = this.ctx.currentTime
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), now)
      this.master.gain.linearRampToValueAtTime(this.volume, now + 0.05)
    }
    this.emit()
  }

  /** 全局热键音量步进（delta 可为负） */
  stepMasterVolume(delta: number): void {
    this.setMasterVolume(this.volume + delta)
  }

  /* ===== 设置（联动配置） ===== */

  setSettings(patch: Partial<NoiseSettings>): void {
    this.settings = { ...this.settings, ...patch }
    saveSettings(this.settings)
    this.emit()
  }

  /* ===== 播放 / 停止 ===== */

  /** 播放预设（多轨混音）。采样轨不可用时跳过并返回提示。 */
  async playPreset(preset: NoisePreset): Promise<PlayResult> {
    this.stopAll()
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        /* 自动播放策略限制：首次需用户手势，忽略 */
      }
    }
    const availability = await this.getSampleAvailability()
    const skipped: string[] = []

    for (const track of preset.tracks) {
      if (track.kind === 'sample') {
        const sampleKey = track.sample as SampleKind
        if (!availability[sampleKey]) {
          skipped.push(sampleLabel(sampleKey))
          continue
        }
      }
      const buffer =
        track.kind === 'synthetic'
          ? createNoiseBuffer(ctx, track.synth as SyntheticNoiseKind, SYNTH_BUFFER_SEC)
          : await this.decodeSample(ctx, track.sample as SampleKind)
      if (!buffer) {
        skipped.push(sampleLabel(track.sample as SampleKind))
        continue
      }
      const loop = new CrossfadeLoop(ctx, buffer, this.master!, { fadeSec: CROSSFADE_SEC })
      loop.setGain(track.volumeHint)
      loop.start()
      this.tracks.set(track.key, {
        key: track.key,
        label: trackLabel(track),
        volume: track.volumeHint,
        loop
      })
    }
    this.emit()
    return { action: 'start', started: this.tracks.size, skipped }
  }

  /** 播放/停止切换（默认用当前设置的预设） */
  async togglePlay(): Promise<PlayResult> {
    if (this.playing) {
      this.stopAll()
      return { action: 'stop', started: 0, skipped: [] }
    }
    return this.playPreset(getNoisePreset(this.settings.preset))
  }

  stopAll(): void {
    for (const track of this.tracks.values()) {
      track.loop.stop()
    }
    this.tracks.clear()
    this.emit()
  }

  /** 单轨音量（0-1） */
  setTrackVolume(key: string, value: number): void {
    const track = this.tracks.get(key)
    if (!track) return
    track.volume = clamp01(value)
    track.loop.setGain(track.volume)
    this.emit()
  }

  /* ===== 休息联动：降音量 / 恢复 ===== */

  /** 休息降音量（平滑 800ms 到目标比例；恢复时回到当前设置音量） */
  duck(level?: number): void {
    if (!this.ctx || !this.master) return
    const target = clamp01(level ?? this.settings.duckLevel)
    const now = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), now)
    this.master.gain.linearRampToValueAtTime(target, now + 0.8)
  }

  /** 恢复原音量（下一个专注开始 / 手动结束时调用） */
  restore(): void {
    if (!this.ctx || !this.master) return
    const now = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), now)
    this.master.gain.linearRampToValueAtTime(this.volume, now + 0.5)
  }

  /* ===== 采样层（M1 留接口） ===== */

  /** 采样素材可用性（主进程解析路径 + exists + url），进程内缓存 */
  private async getSampleAvailability(): Promise<Record<string, boolean>> {
    if (this.assetsCache) {
      return Object.fromEntries(
        Object.entries(this.assetsCache).map(([k, v]) => [k, v.exists])
      )
    }
    try {
      const assets = await window.api.audio.getAssets()
      this.assetsCache = Object.fromEntries(
        assets.map((asset) => [asset.key, { exists: asset.exists, url: asset.url }])
      )
    } catch {
      this.assetsCache = {}
    }
    return Object.fromEntries(
      Object.entries(this.assetsCache).map(([k, v]) => [k, v.exists])
    )
  }

  /**
   * 解码采样素材。经 tomato-audio:// 协议 fetch → decodeAudioData，按 key 缓存。
   * 素材不可用时返回 null，调用方自动跳过采样轨（降级逻辑）。
   */
  private async decodeSample(ctx: AudioContext, key: SampleKind): Promise<AudioBuffer | null> {
    if (this.bufferCache.has(key)) return this.bufferCache.get(key)!
    // 确保 assetsCache 已初始化
    await this.getSampleAvailability()
    const info = this.assetsCache?.[key]
    if (!info || !info.exists || !info.url) return null
    try {
      const res = await fetch(info.url)
      if (!res.ok) return null
      const buf = await ctx.decodeAudioData(await res.arrayBuffer())
      this.bufferCache.set(key, buf)
      return buf
    } catch (err) {
      console.warn(`[audio] 采样素材解码失败 (${key}):`, err)
      return null
    }
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function sampleLabel(key: SampleKind): string {
  const labels: Record<SampleKind, string> = {
    rain: '雨声',
    cafe: '咖啡厅',
    forest: '森林',
    library: '图书馆',
    waves: '海浪',
    fire: '篝火',
    fan: '风扇',
    birds: '鸟鸣'
  }
  return labels[key] ?? key
}

function trackLabel(track: NoisePreset['tracks'][number]): string {
  if (track.kind === 'sample') return sampleLabel(track.sample as SampleKind)
  const labels: Record<SyntheticNoiseKind, string> = { white: '白噪', pink: '粉噪', brown: '棕噪' }
  return labels[track.synth as SyntheticNoiseKind] ?? track.key
}

/** 全局单例（渲染层共享：控件 / 专注联动 / 热键事件共用） */
export const noiseEngine = new NoiseEngine()
