/**
 * 白噪音模块共享类型与配置（主进程 / preload / 渲染层共用）。
 * 仅类型 + 纯数据常量，不含任何运行时实现。
 */

/* ===== 音源种类 ===== */

/** 合成层：白 / 粉 / 棕噪（零成本，M1 交付） */
export type SyntheticNoiseKind = 'white' | 'pink' | 'brown'

/** 采样层：8 种自然素材（M1 留接口，素材规格见 resources/audio/README.md） */
export type SampleKind = 'rain' | 'cafe' | 'forest' | 'library' | 'waves' | 'fire' | 'fan' | 'birds'

/* ===== 采样素材规格（方案 2.8） ===== */

export interface SampleAssetSpec {
  key: SampleKind
  label: string
  /** 素材文件名，如 rain.mp3；打包于 resources/audio/ */
  file: string
  /** 规格说明（MP3/WAV 44.1kHz、30–60s、单文件 ≤5MB、本地打包） */
  spec: string
  /** 推荐音量比例（0-1），供预设组合混音使用 */
  volumeHint: number
}

/** 8 种采样素材目录（全部按统一规格录制/加工） */
export const SAMPLE_ASSET_SPECS: SampleAssetSpec[] = [
  { key: 'rain', label: '雨声', file: 'rain.mp3', spec: 'MP3 44.1kHz 30-60s ≤5MB 本地打包', volumeHint: 1.0 },
  { key: 'cafe', label: '咖啡厅', file: 'cafe.mp3', spec: 'MP3 44.1kHz 30-60s ≤5MB 本地打包', volumeHint: 1.0 },
  { key: 'forest', label: '森林', file: 'forest.mp3', spec: 'MP3 44.1kHz 30-60s ≤5MB 本地打包', volumeHint: 1.0 },
  { key: 'library', label: '图书馆', file: 'library.wav', spec: 'WAV 44.1kHz/16bit 30-60s ≤5MB 本地打包', volumeHint: 1.0 },
  { key: 'waves', label: '海浪', file: 'waves.mp3', spec: 'MP3 44.1kHz 30-60s ≤5MB 本地打包', volumeHint: 1.0 },
  { key: 'fire', label: '篝火', file: 'fire.mp3', spec: 'MP3 44.1kHz 30-60s ≤5MB 本地打包', volumeHint: 1.0 },
  { key: 'fan', label: '风扇', file: 'fan.mp3', spec: 'MP3 44.1kHz 30-60s ≤5MB 本地打包', volumeHint: 1.0 },
  { key: 'birds', label: '鸟鸣', file: 'birds.mp3', spec: 'MP3 44.1kHz 30-60s ≤5MB 本地打包', volumeHint: 0.6 }
]

/** 采样素材可用性 + 绝对路径（主进程解析后下发） */
export interface AssetInfo extends SampleAssetSpec {
  /** 素材文件是否真实存在（未打包时为 false，采样轨跳过） */
  exists: boolean
  path: string
  /** 渲染层可 fetch 的 URL（tomato-audio:// 自定义协议，主进程注册） */
  url?: string
}

/* ===== 预设（方案 2.8：多音轨组合 + 推荐音量比例） ===== */

export interface NoiseTrackConfig {
  key: string
  kind: 'synthetic' | 'sample'
  synth?: SyntheticNoiseKind
  sample?: SampleKind
  /** 推荐音量比例（0-1） */
  volumeHint: number
}

export interface NoisePreset {
  key: string
  label: string
  tracks: NoiseTrackConfig[]
}

/** 预设目录：合成层 3 个 + 采样层组合 8 个（采样轨在素材打包后自动生效） */
export const NOISE_PRESETS: NoisePreset[] = [
  { key: 'white', label: '白噪', tracks: [{ key: 'white', kind: 'synthetic', synth: 'white', volumeHint: 1 }] },
  { key: 'pink', label: '粉噪', tracks: [{ key: 'pink', kind: 'synthetic', synth: 'pink', volumeHint: 1 }] },
  { key: 'brown', label: '棕噪', tracks: [{ key: 'brown', kind: 'synthetic', synth: 'brown', volumeHint: 1 }] },
  {
    key: 'rain',
    label: '雨声',
    tracks: [{ key: 'rain', kind: 'sample', sample: 'rain', volumeHint: 1 }]
  },
  {
    key: 'cafe',
    label: '咖啡厅',
    tracks: [
      { key: 'cafe', kind: 'sample', sample: 'cafe', volumeHint: 1 },
      { key: 'brown-bg', kind: 'synthetic', synth: 'brown', volumeHint: 0.25 }
    ]
  },
  {
    key: 'forest',
    label: '森林',
    tracks: [
      { key: 'forest', kind: 'sample', sample: 'forest', volumeHint: 1 },
      { key: 'birds', kind: 'sample', sample: 'birds', volumeHint: 0.5 }
    ]
  },
  {
    key: 'library',
    label: '图书馆',
    tracks: [
      { key: 'library', kind: 'sample', sample: 'library', volumeHint: 1 },
      { key: 'pink-bg', kind: 'synthetic', synth: 'pink', volumeHint: 0.3 }
    ]
  },
  {
    key: 'waves',
    label: '海浪',
    tracks: [
      { key: 'waves', kind: 'sample', sample: 'waves', volumeHint: 1 },
      { key: 'brown-bg', kind: 'synthetic', synth: 'brown', volumeHint: 0.3 }
    ]
  },
  {
    key: 'fire',
    label: '篝火',
    tracks: [
      { key: 'fire', kind: 'sample', sample: 'fire', volumeHint: 1 },
      { key: 'brown-bg', kind: 'synthetic', synth: 'brown', volumeHint: 0.3 }
    ]
  },
  { key: 'fan', label: '风扇', tracks: [{ key: 'fan', kind: 'sample', sample: 'fan', volumeHint: 1 }] },
  { key: 'birds', label: '鸟鸣', tracks: [{ key: 'birds', kind: 'sample', sample: 'birds', volumeHint: 0.8 }] }
]

export function getNoisePreset(key: string): NoisePreset {
  return NOISE_PRESETS.find((preset) => preset.key === key) ?? NOISE_PRESETS[0]
}

/* ===== 引擎参数（方案 2.8） ===== */

/** 双节点交叉淡入淡出时长（秒） */
export const CROSSFADE_SEC = 1.5
/** 合成噪声缓冲时长（秒）；4s 起，交接间隔 = 时长 - 淡入时长 */
export const SYNTH_BUFFER_SEC = 4
/** 热键单步音量步进 */
export const HOTKEY_VOLUME_STEP = 0.05
/** 休息降音量的默认目标比例 */
export const DEFAULT_DUCK_LEVEL = 0.25

/* ===== 联动设置（专注开始自动播 / 休息动作） ===== */

export type RestAction = 'stop' | 'duck' | 'none'

export interface NoiseSettings {
  /** 当前预设 key */
  preset: string
  /** 主音量（0-1） */
  volume: number
  /** 专注开始时自动播放（可配） */
  autoPlayOnStart: boolean
  /** 到点（休息）动作：暂停 / 降音量 / 不变 */
  restAction: RestAction
  /** 降音量的目标比例 */
  duckLevel: number
}

export const DEFAULT_NOISE_SETTINGS: NoiseSettings = {
  preset: 'white',
  volume: 0.6,
  autoPlayOnStart: false,
  restAction: 'duck',
  duckLevel: DEFAULT_DUCK_LEVEL
}
