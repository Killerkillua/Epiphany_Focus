# 番茄专注 Pro (Pomodoro Focus Pro)

强制专注番茄钟桌面应用，基于 **Electron + React 18 + TypeScript** 构建。通过番茄工作法结合强制防打扰机制（锁屏、进程守护等），帮助用户进入深度专注状态；内置 AI 助手、白噪音、B 站学习与英语学习模式，兼顾「专注」与「学习」两大场景。

## 功能特性

- **番茄钟计时**：专注/短休/长休阶段配置，会话统计与连续专注追踪
- **强制专注引擎**：专注期间开启锁定屏幕、屏蔽指定进程/快捷键/窗口等防打扰机制，并支持紧急退出兜底
- **B 站学习模式**：内置搜索（WBI 签名）、图片代理与全屏锁定，专注期间直接学习视频内容
- **英语学习模式**：AI 对话 + 笔记记录，支持接本地大模型 API
- **AI 助手**：多模态对话、OCR 识别、RAG 检索（本地 SQLite 存储）
- **白噪音**：内置自然采样音频（雨声、篝火、海浪等），支持无缝循环与混合
- **悬浮面板**：独立小窗展示会话进度、笔记与 AI 聊天，可展开/最小化/隐藏
- **数据管理**：本地 SQLite 持久化，支持进度统计图表、备份与恢复
- **自定义设置**：AI Key（BYOK）、番茄参数、强制等级、噪音与学习配置等

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron 33 + electron-vite |
| 前端 | React 18 + TypeScript + antd 5 + zustand |
| 数据存储 | better-sqlite3 + electron-store |
| AI | OpenAI SDK（兼容 SiliconFlow 等 OpenAI 协议端点） |
| 测试/质量 | vitest + ESLint + Prettier |
| 打包 | electron-builder（Windows / macOS / Linux） |

## 目录结构

```
Tomato time/
├── pomodoro-focus-pro/      # 主应用（Electron）
│   ├── src/main/            # 主进程：计时、强制引擎、AI、音频、导航、存储、会话
│   ├── src/preload/         # 预加载脚本与类型桥接
│   ├── src/renderer/        # 渲染进程：页面、组件、store、悬浮面板
│   ├── src/shared/          # 主/渲染进程共享的常量、类型与工具
│   ├── docs/                # 设计文档与架构评审报告
│   └── resources/audio/     # 白噪音采样音频
├── landing/                 # 官网落地页
└── .MP3/                    # 白噪音原始素材（不入库）
```

## 快速开始

```bash
# 1. 安装依赖
cd pomodoro-focus-pro
npm install

# 2. 配置 AI Key（可选，留空则走演示模式）
# 复制 .env 文件并按需填写，或首次启动后在「设置 → AI」中填写
POMODORO_AI_API_KEY=sk-xxxx

# 3. 启动开发模式
npm run dev

# 4. 类型检查 / 测试 / 代码规范
npm run typecheck
npm test
npm run lint

# 5. 构建安装包
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

> 敏感配置（如 `.env`）已被 `.gitignore` 排除，请勿将真实 Key 提交到仓库。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `POMODORO_AI_API_KEY` | AI 服务 Key（留空 = 演示模式）。应用首次启动自动从 `.env` 加载并注入设置 |

## 许可证

MIT
