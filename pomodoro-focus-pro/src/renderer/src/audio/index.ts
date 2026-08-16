/** 白噪音引擎统一出口（渲染层） */
export { noiseEngine } from './engine'
export { CrossfadeLoop } from './seamlessLoop'
export { createNoiseBuffer } from './synth'
export { loadSettings, saveSettings } from './presets'
export type { PlayResult, ActiveTrack } from './engine'
