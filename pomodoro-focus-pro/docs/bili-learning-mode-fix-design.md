# B 站学习模式：问题修复与前端设计方案

> 适用范围：`pomodoro-focus-pro`（Electron + React + TypeScript）
> 覆盖三个问题：① 删除悬浮球模式并重构学习助手（最小 610×940，可拖拽/最小化）；② 打开视频后窗口不显示、全屏遮罩无法退出的重新根因分析；③ B 站学习页顶部导航栏右侧"学习助手"前端设计方案（反馈模块迁移至设置页）。

---

## 一、问题 1：删除悬浮球模式 + 学习助手重构

### 1.1 现象描述

B 站学习模式打开视频后，学习助手以 56×56 悬浮球（collapsed 态）呈现。鼠标按住球体拖动时，悬浮窗口尺寸持续增大（DPI 坐标错配 + 透明窗口 setPosition 平台副作用 + 指针捕获丢失叠加导致）。用户目标：**彻底删除悬浮球状态**，学习助手始终以展开态呈现，展开窗口支持**拖拽移动**与**最小化**，且**最小窗口 610×940**。

### 1.2 现状代码定位

| 位置     | 文件                                        | 说明                                                                                                   |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 尺寸常量 | `src/shared/bili.ts`                        | `OVERLAY_EXPANDED_SIZE = {340,560}`、`OVERLAY_COLLAPSED_SIZE = {56,56}`、`OverlayState` 含 `collapsed` |
| 状态机   | `src/main/navigation/biliWindow.ts`         | `applyOverlayState()` 4 态分支（expanded/collapsed/minimized/hidden）                                  |
| 窗口配置 | `src/main/navigation/biliWindow.ts`         | `createOverlay()`：`resizable:false`、`minimizable:opts.allowMinimize`                                 |
| 球体渲染 | `src/renderer/src/overlay/OverlayApp.tsx`   | `state.phase === 'collapsed'` 分支渲染球体 + 快捷按钮                                                  |
| 球体拖拽 | `src/renderer/src/overlay/useWindowDrag.ts` | 指针事件 → `overlayMoveBy` → `setPosition`                                                             |
| 头部按钮 | `src/renderer/src/overlay/OverlayApp.tsx`   | 最小化 / 隐藏 / **缩小为球** / 关闭视频                                                                |
| 球体样式 | `src/renderer/src/styles/global.css`        | `.overlay-ball*` 系列                                                                                  |

### 1.3 重构方案

#### 1.3.1 状态机简化（主进程 `biliWindow.ts`）

- `OverlayState` 从 4 态收敛为 **3 态**：`expanded / minimized / hidden`，删除 `collapsed`。
- `applyOverlayState()` 删除 `collapsed` 分支；`toggleOverlayHide()` 恢复时固定回到 `expanded`。
- 删除 `ballPosition` 位置记忆与 `OVERLAY_COLLAPSED_SIZE`；`dockOverlay()` 只处理展开态停靠。
- 删除 `useWindowDrag.ts` 整条球体拖拽链路（`overlayMoveBy` IPC 可保留供展开态 header 拖拽兜底，或一并移除）。

#### 1.3.2 窗口配置（`createOverlay`）

```typescript
const overlay = new BrowserWindow({
  width: 610, // 默认展开尺寸（≥ 最小 610×940）
  height: 940,
  minWidth: 610, // 最小窗口 610×940
  minHeight: 940,
  frame: false,
  transparent: true,
  resizable: true, // 允许缩放（配合 minWidth/minHeight 约束）
  movable: true, // 允许拖拽
  minimizable: opts.allowMinimize, // L0/L1 可最小化
  maximizable: false,
  alwaysOnTop: true,
  skipTaskbar: !opts.showInTaskbar,
  show: false,
  hasShadow: false,
  backgroundColor: '#00000000',
  webPreferences: {/* 保持不变 */}
})
overlay.setMinimumSize(610, 940)
```

> 说明：
>
> - **拖拽**：展开态 header 已通过 `-webkit-app-region: drag` 原生拖拽（`global.css` `.overlay-header`），`overlay.on('move')` 记录 `panelPosition`，无需新增逻辑。
> - **最小化**：`minimizable: opts.allowMinimize` 已支持（L0/L1），`applyOverlayState('minimized')` 已有实现；展开态头部"最小化"按钮保留。
> - **缩放**：`resizable:true` + `setMinimumSize(610,940)` 支持系统级缩放；若需"四角以对角为锚点等比例缩放"，可在渲染层增加四角 resize 手柄（pointer 事件 → 上报增量 → 主进程 `resizeOverlay` 同步 x/y/width/height），并保持最小 610×940。
> - **透明窗口注意**：Windows 上 `transparent:true` + `resizable:true` 存在已知渲染抖动风险，若实测异常可改用 `backgroundColor:'#0f1115'` 不透明方案或 `roundedCorners` 关闭。

#### 1.3.3 渲染层（`OverlayApp.tsx`）

- 删除 `state.phase === 'collapsed'` 分支与球体 JSX。
- 头部按钮组删除"缩小为球"（`MenuFoldOutlined`），保留：最小化 / 隐藏 / 关闭视频。
- `requestPhase('collapsed')` 相关 dispatch 全部移除；`minimize`/`hide` 逻辑保留。

#### 1.3.4 样式（`global.css`）

- 删除 `.overlay-ball*` 全部规则（球体、进度环、快捷按钮、note/exit 悬浮钮）。
- `.overlay-root` 适配 610×940：内容区（对话/笔记/进度）随窗口放大，列表与输入区弹性布局，避免内容被拉伸变形。

#### 1.3.5 验收标准

- [ ] 打开视频后学习助手始终为展开态，不再出现悬浮球。
- [ ] 展开窗口可拖动 header 移动位置。
- [ ] 展开窗口可最小化（L0/L1），任务栏/快捷键可恢复。
- [ ] 窗口最小尺寸 610×940，无法缩得更小。
- [ ] 通过 `npm run typecheck` 与本地运行验证。

---

## 二、问题 2：打开视频后窗口不显示 + 全屏遮罩无法退出（重新根因分析）

### 2.1 新现象描述（用户反馈）

1. 正常点击视频卡片 → 渲染层提示"已打开视频"（IPC 成功返回）。
2. **视频窗口不会正常显示**（黑屏 / 被遮挡 / 空白全屏）。
3. **后续全屏遮罩无法关闭**，即使使用强制关闭（紧急退出）也无法退出全屏遮罩。

### 2.2 关键调用链

```
session.start（计时开始）
  └─ applySessionOverlay() → applyLevelWindow(主窗口)
       主窗口：setFullScreen(true) + setAlwaysOnTop(true,'screen-saver')
              + setResizable(false) + setSkipTaskbar(true) + 拦截 close
       overlayStates: 主窗口 count=1

bili.openVideo（点击视频）
  └─ openVideo(payload)
       ├─ closeVideo()                                     // 幂等：先关旧窗
       ├─ onBeforeOpen() → session.suspendOverlay()       // P-2 前置：创建窗口前先释放主窗口遮罩
       ├─ new BrowserWindow({ fullscreen: autoFullscreen, show: false, ... })   // 视频窗口，未置顶
       ├─ attachFullscreenLock(video, { autoFullscreen, ... })
       │     └─ autoFullscreen 延迟到 'show' 后 setFullScreen(true) + resize 拉回
       │        + before-input-event：主进程兜底检测 5×Esc（3s 窗口）→ 唤起紧急退出弹窗
       ├─ video.show()                                     // P-2：创建后立即显示（不等 ready-to-show）
       ├─ video.loadURL('https://www.bilibili.com/video/BV...')
       ├─ createOverlay(video, ...)                        // 悬浮面板（置顶）
       ├─ active = { video, overlay, ... }
       └─ onOpenCallback(video, payload)   // navigation/index.ts
             ├─ enforcement.enterBiliSession(video, ...)
             │     └─ beginEnforcement('bili', cap, videoWin)
             │           ├─ emergency.assertExitSafety(level)      // 未设恢复码则抛异常
             │           ├─ applyLevelWindow(videoWin, { skipAlwaysOnTop:true })
             │           │     视频窗口：setFullScreen(true) + setResizable(false)
             │           │             + setSkipTaskbar(true) + 拦截 close
             │           │     overlayStates: 视频窗口 count=1
             │           ├─ registerShortcutGuard()                 // 消费 F11/Ctrl+T/W/R/F5
             │           └─ windowGuard.start(videoWin, ...)        // blur 400ms 拉回
             ├─ upsertPlayRecord(...)
             ├─ enforcement.setOverlayExempt(getOverlayWindow())
             ├─ ensureOverlayOnTop()
             └─ finally: session.suspendOverlay()          // P-2 兜底：无论成败再释放一次（幂等）
```

> **实现状态（P-2 已落地）**：`session.suspendOverlay()` 已前置到 `onBeforeOpen`（创建视频窗口之前），
> `onOpen` 回调整体 `try/catch/finally`，`finally` 中再次 `suspendOverlay()` 幂等兜底——
> 即使 `enterBiliSession` 抛错（如未设恢复码），主窗口遮罩也必然释放。

```

### 2.3 根本原因分析

#### 2.3.1 主因：主窗口 screen-saver 置顶遮罩与视频窗口的 z-order 冲突

计时开始后，主窗口被施加"全屏 + screen-saver 置顶"遮罩（`applySessionOverlay`）。打开视频时：

- 视频窗口以 `fullscreen:true` 创建，但 B 站模式 **`skipAlwaysOnTop:true` 不置顶**（为让悬浮面板浮于视频之上）。
- 主窗口 `screen-saver` 置顶层级**恒高于**未置顶的视频窗口 → 视频窗口创建后立即被主窗口全屏遮罩**盖住**。
- **现状（已修复）**：`session.suspendOverlay()` 已前置到 `onBeforeOpen`（创建视频窗口之前）+ `onOpen` 的 `finally` 幂等兜底，原有两个风险已消除：
  1. ~~异常跳过~~：`enterBiliSession`（`assertExitSafety` 未设恢复码时抛错）或 `upsertPlayRecord` 抛错 → `finally` 仍执行 `suspendOverlay()`，主窗口遮罩不会残留。
  2. ~~引用计数叠加~~：`suspendOverlay()` 为幂等释放（计数归零），`restoreAfterRestart` 叠加场景由释放侧统一收敛。
  3. **Windows 异步过渡**：`setFullScreen(false)` + `setAlwaysOnTop(false)` 是异步过渡，存在层级竞争窗口期，视频窗口可能无法及时浮出（保留观察项）。

#### 2.3.2 次因：视频窗口全屏显示异常

- 视频窗口 `show` 默认 `true`，创建即显示为**深色全屏窗口**（`backgroundColor:'#0f1115'`）。
- B 站页面加载期间（或需登录 / 加载失败 / 播放器未初始化）用户看到的是**黑屏全屏**，误判为"视频窗口不显示"。
- `ready-to-show` → `video.show()` 与 `attachFullscreenLock` 的 `setFullScreen(true)` 在 Windows 上存在"先全屏后显示"的显示异常风险（**已修复**：`show:false` 创建 → 立即 `show()` → `autoFullscreen` 延迟到 `show` 事件后再 `setFullScreen(true)`）。

#### 2.3.3 次因：全屏遮罩无法关闭（强制关闭无效）

1. **视频窗口被拦截关闭**：`applyLevelWindow(videoWin)` 添加 `close` 处理器 `event.preventDefault()` + `setSkipTaskbar(true)` + `setResizable(false)`。Alt+F4 / 关闭按钮 / 任务栏均无法关闭视频窗口。
2. **紧急退出不销毁视频窗口**：`endEnforcement('emergency')` 中 `const win = target ?? getWindow()` 取的是**主窗口**，`releaseLevelWindow(主窗口)` 对主窗口计数为 0 时是 no-op；**视频窗口的遮罩（count=1）从不释放，视频窗口也从不销毁**。紧急退出成功后视频窗口仍保持全屏 + 拦截关闭 + 隐藏任务栏，用户被永久困在全屏。
3. **Escape 被消费**：`attachFullscreenLock` 的 `before-input-event` 在视频窗口消费 Escape；而"连按 5 次 Esc"紧急退出检测位于**主窗口渲染层**。视频窗口聚焦时主窗口收不到 Esc，紧急退出根本无法触发（**已修复**：主进程在视频窗口侧兜底检测 5×Esc，命中后唤起主窗口紧急退出弹窗，见 2.4 第 5 条）。

### 2.4 修复建议（按优先级，均已实现，此处与代码现状对齐）

1. ✅ **释放主窗口遮罩前置**：`session.suspendOverlay()` 前移到 `onBeforeOpen`（创建/显示视频窗口**之前**执行，`biliWindow.openVideo` 调用）；`onOpen` 回调整体 `try/catch/finally`，`finally` 中再次 `suspendOverlay()` 幂等兜底，保证必然执行（`navigation/index.ts`）。
2. ✅ **紧急退出兜底销毁视频窗口**：`endEnforcement('emergency')` 调用 `closeVideo()`（`video.destroy()` 绕过 close 拦截）并级联销毁悬浮面板、释放遮罩，确保紧急退出后无残留全屏窗口（`enforcement/index.ts`）。
3. ✅ **恢复码前置校验前移**：`bili.openVideo` 的 IPC 处理器在创建视频窗口前先 `assertExitSafety` 校验（`navigation/index.ts`），未设恢复码时直接拒绝，避免"窗口已创建但会话失败"的中间态。
4. ✅ **视频窗口显示兜底**：视频窗口以 `show:false` 创建后立即 `show()`（不等 `ready-to-show`，页面加载失败/需登录时窗口也不至于永不显示）；`autoFullscreen` 延迟到 `show` 事件后再 `setFullScreen(true)`，规避"先全屏后显示"异常（`biliWindow.ts` / `fullscreenLock.ts`）。
5. ✅ **Escape 兜底（主进程）**：视频窗口聚焦时主窗口渲染层收不到 Esc，"连按 5 次 Esc"渲染层检测失效——由主进程在视频窗口 `before-input-event` 兜底检测 5×Esc（3 秒窗口），命中后经 `onEscapeSpam` 唤起主窗口紧急退出弹窗，保证紧急退出始终可达；单次 Esc 仍被消费，防止 B 站播放器退全屏触发"退出→拉回"闪烁（`fullscreenLock.ts`）。
6. ℹ️ **onOpen 回滚时序**：强制会话启动失败时，`closeVideo()`（同步 `video.destroy()`）推迟到 `setImmediate` 执行——`openVideo` 在 `onOpen` 返回后仍会访问 `video`（如 `isFullScreen()` 上报状态），同步销毁会导致"访问已销毁窗口"抛错（`navigation/index.ts`）。

---

## 三、问题 3：B 站学习页顶部导航栏右侧"学习助手"前端设计方案

### 3.1 现状

- B 站学习页（`BiliModePage.tsx`）顶部导航栏右侧目前是**"反馈"按钮**（`MessageOutlined`），点击弹出 `FeedbackDialog`。
- 学习助手（对话/笔记/进度三页签）**只存在于视频打开后的独立 overlay 窗口**（`#overlay` 路由，`OverlayApp`），生命周期绑定视频窗口；非视频模式下无任何入口，笔记内容的修改/删除不可用。
- 用户目标：把顶部导航栏右侧的"反馈"模块**重构为"学习助手"模块**（非视频模式也可用，支持内容修改/删除），现有反馈模块**迁移到设置页**。

### 3.2 设计目标

1. **非视频模式可用**：B 站学习页顶部导航栏右侧提供"学习助手"入口，未打开视频时也能打开助手，管理笔记（新增/修改/删除）、查看进度、使用 AI 对话。
2. **与视频模式联动**：打开视频后，助手以独立悬浮窗口呈现（问题 1 重构后的展开态）；非视频模式与视频模式共享同一套笔记/进度数据（SQLite `notes` / `play_records` 表）。
3. **反馈迁移**：反馈入口从 B 站学习页移除，迁移至设置页"帮助改进"卡片区域。

### 3.3 交互设计

#### 3.3.1 顶部导航栏入口（BiliModePage）

```

┌──────────────────────────────────────────────────────────────────┐
│ B 站学习模式 [学习助手 ▾] │
│ 输入学习主题 → WBI 签名搜索 → 结果网格 → 点击视频自动全屏… │
└──────────────────────────────────────────────────────────────────┘

```

- **入口形态**：`Button` + `RobotOutlined` 图标 + 文案"学习助手"，带下拉箭头。
- **交互**：
  - 点击 → 打开右侧**抽屉（Drawer）**，宽度 420px，高度占满（与视频模式悬浮面板视觉一致）。
  - 抽屉内三页签：**对话 / 笔记 / 进度**（复用 `ChatPane` / `NotesPane` / `ProgressPane` 组件，与 overlay 一致）。
  - 打开视频后抽屉自动关闭（避免与悬浮面板重复）；关闭视频回到非视频模式时抽屉可再次打开。
  - 抽屉内笔记页签支持：新建、选择、**修改（编辑草稿）**、**删除**、导出 Markdown、OCR 插图（复用 `NotesPage` 能力）。

#### 3.3.2 抽屉内容结构

```

┌──────────────────────────────┐
│ 学习助手 [最小化] [×]│ ← 头部：标题 + 关闭
├──────────────────────────────┤
│ [对话] [笔记 ●] [进度] │ ← 三页签
├──────────────────────────────┤
│ 对话页签：AI 问答（基于当前主题）│
│ 笔记页签：笔记列表 + 编辑区 │
│ 进度页签：播放记录 / 目标 / 完成│
└──────────────────────────────┘

```

- **对话页签**：非视频模式无 `bvid` 上下文，AI 基于**当前学习主题**（搜索关键词）作答；`ChatPane` 增加"无视频上下文"空态提示。
- **笔记页签**：`NotesPane` 复用，非视频模式 `context` 为空时隐藏"标记关键点/跳转"按钮，仅保留编辑/删除/导出/OCR。
- **进度页签**：`ProgressPane` 复用，非视频模式展示全部 `play_records` 列表（含目标、完成状态），可点击"跳转"时先打开对应视频。

#### 3.3.3 与视频模式悬浮面板的关系

| 场景 | 助手呈现 | 数据 |
| --- | --- | --- |
| 未打开视频 | 顶部导航栏抽屉（学习助手模块） | 同一 SQLite 表 |
| 打开视频 | 独立悬浮窗口（展开态，可拖拽/最小化） | 同一 SQLite 表 |
| 视频关闭 | 回到顶部导航栏抽屉 | 同一 SQLite 表 |

- 两者共享 `notes` / `play_records` 数据，切换场景时通过 `loadNotesAll()` / `listPlayRecords()` 刷新。
- 抽屉与悬浮面板**互斥**：打开视频时抽屉关闭；悬浮面板隐藏/最小化时抽屉可打开。

### 3.4 视觉设计

- **风格**：与现有深色主题一致（`#0f1115` 背景、`#ff6b4a` 强调色、`--rule` 边框、8px 圆角）。
- **抽屉**：右侧滑出，宽度 420px，头部 38px 与悬浮面板 header 一致，页签样式复用 `.overlay-tab`。
- **入口按钮**：`Button` 主色描边 + `RobotOutlined`，hover 高亮，与"反馈"按钮视觉层级一致。
- **空态**：非视频模式对话页签显示"当前未打开视频，可基于学习主题提问"；进度页签显示"暂无播放记录"。
- **响应式**：抽屉高度随主窗口变化，列表区 `flex:1` + `overflow:auto`，输入区固定底部。

### 3.5 组件结构

```

src/renderer/src/
├── components/
│ └── LearningAssistantDrawer.tsx // 新增：顶部导航栏学习助手抽屉（三页签容器）
├── pages/
│ └── BiliModePage.tsx // 修改：反馈按钮 → 学习助手按钮 + 抽屉挂载
├── pages/
│ └── SettingsPage.tsx // 修改：新增"反馈"入口（复用 FeedbackDialog）
├── overlay/
│ ├── ChatPane.tsx // 复用（增加无视频上下文空态）
│ ├── NotesPane.tsx // 复用（非视频模式隐藏视频相关操作）
│ └── ProgressPane.tsx // 复用（非视频模式展示全部记录）
└── components/
└── FeedbackDialog.tsx // 复用（迁移到设置页）

```

- `LearningAssistantDrawer` 内部复用 `ChatPane` / `NotesPane` / `ProgressPane`，通过 props 传入 `context`（可为 null）与数据加载函数。
- 抽屉状态由 `BiliModePage` 本地 state 管理（`assistantOpen`）；监听 `videoOpened` / `videoClosed` 事件自动开合。

### 3.6 数据流

```

BiliModePage
├─ 点击"学习助手" → assistantOpen=true → 渲染 LearningAssistantDrawer
├─ Drawer 挂载 → loadNotesAll() / listPlayRecords() / getContext()（可为 null）
├─ 笔记修改/删除 → window.api.notes.upsert / notes.delete → SQLite → 刷新列表
├─ 对话 → window.api.ai.ask（基于 topic，无 bvid 时降级）
└─ 监听 IPC_EVENTS.bili.videoOpened/videoClosed → 自动关闭/允许打开抽屉

```

### 3.7 反馈模块迁移（设置页）

- **移除**：`BiliModePage.tsx` 中"反馈"按钮与 `FeedbackDialog` 挂载（第 193–196 行、第 315 行）。
- **新增**：`SettingsPage.tsx` 的"帮助改进"卡片（`📈 帮助改进`）内增加"提交反馈"按钮，点击复用 `FeedbackDialog`（`mode="bili"` 或 `general`）。
- **IPC 不变**：`feedback.submit` / `feedback.list` / `feedback.stats` 通道保持，无需改动主进程。

### 3.8 验收标准

- [ ] 顶部导航栏右侧为"学习助手"入口，点击打开抽屉（对话/笔记/进度三页签）。
- [ ] 非视频模式下可新建/修改/删除笔记，数据与视频模式共享。
- [ ] 打开视频时抽屉自动关闭，悬浮面板正常呈现；关闭视频后抽屉可重新打开。
- [ ] 反馈入口已迁移至设置页，B 站学习页不再出现"反馈"按钮。
- [ ] 通过 `npm run typecheck` 与本地运行验证。

---

## 附：相关文件清单

| 文件 | 涉及问题 | 改动类型 |
| --- | --- | --- |
| `src/shared/bili.ts` | 1 | 删除 `collapsed` 态、调整尺寸常量 |
| `src/main/navigation/biliWindow.ts` | 1、2 | 状态机简化、窗口配置、遮罩释放前置、紧急退出兜底 |
| `src/main/navigation/index.ts` | 2 | `onOpen` 回调 try/catch/finally + `suspendOverlay` 前置 |
| `src/main/enforcement/index.ts` | 2 | `endEnforcement` 增加视频窗口清理 |
| `src/main/enforcement/emergencyExit.ts` | 2 | `assertExitSafety` 前移到 `openVideo` IPC 入口 |
| `src/main/navigation/fullscreenLock.ts` | 2 | Escape 放行策略调整 |
| `src/renderer/src/overlay/useWindowDrag.ts` | 1 | 删除球体拖拽链路 |
| `src/renderer/src/overlay/OverlayApp.tsx` | 1、3 | 删除球体分支、头部按钮调整 |
| `src/renderer/src/styles/global.css` | 1、3 | 删除球体样式、适配 610×940、抽屉样式 |
| `src/renderer/src/pages/BiliModePage.tsx` | 3 | 反馈按钮 → 学习助手入口 |
| `src/renderer/src/components/LearningAssistantDrawer.tsx` | 3 | 新增 |
| `src/renderer/src/pages/SettingsPage.tsx` | 3 | 新增反馈入口 |
```
