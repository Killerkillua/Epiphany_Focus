# 白噪音采样素材规格（方案 2.8）

采样层共 **8 种**自然素材，M1 阶段仅留接口（`src/renderer/src/audio/engine.ts` 的
`decodeSample` 占位），**素材未打包时对应音轨自动跳过**，合成层白/粉/棕噪不受影响。

## 统一规格

| 项 | 要求 |
|---|---|
| 格式 | **MP3**（library 为 WAV，freesound 原声保留） |
| 采样率 / 位深 | **44.1kHz**（WAV 为 16bit） |
| 时长 | **30–60s**（无缝循环素材；越短越利于双节点交叉淡入淡出调度） |
| 峰值 | **-3dB**（峰值归一化，留 3dB 余量防叠加削波） |
| 单文件 | **≤5MB** |
| 存放 | 本地打包 `resources/audio/`（electron-builder `asarUnpack: resources/**` 外置） |
| 循环衔接 | 素材首尾在录制/剪辑时对齐（可选做 0.5s 交叉淡化母带），引擎另有 1.5s 双节点交叉淡入淡出兜底 |

## 文件清单（文件名与 src/shared/audio.ts 中 SAMPLE_ASSET_SPECS 一一对应）

| 文件名 | 键名 | 名称 | 推荐音量 |
|---|---|---|---|
| `rain.mp3` | rain | 雨声 | 1.0 |
| `cafe.mp3` | cafe | 咖啡厅 | 1.0 |
| `forest.mp3` | forest | 森林 | 1.0 |
| `library.wav` | library | 图书馆 | 1.0 |
| `waves.mp3` | waves | 海浪 | 1.0 |
| `fire.mp3` | fire | 篝火 | 1.0 |
| `fan.mp3` | fan | 风扇 | 1.0 |
| `birds.mp3` | birds | 鸟鸣 | 0.6 |

## 预设组合（src/shared/audio.ts NOISE_PRESETS）

- 咖啡厅 = cafe + 棕噪(0.25)
- 森林 = forest + birds(0.5)
- 图书馆 = library + 粉噪(0.3)
- 海浪 = waves + 棕噪(0.3)
- 篝火 = fire + 棕噪(0.3)

采样轨未打包时，预设仅保留合成层子轨（如咖啡厅退化为纯棕噪），并跳过提示。
