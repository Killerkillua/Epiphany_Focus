# 番茄专注 Pro 渲染进程代码审查报告

**审查范围**：`src/renderer/src/` 下全部模块（components / pages / store / audio / overlay / utils / App.tsx / main.tsx）
**审查日期**：2026-08-22
**审查规则**：React 规范 · 性能 · 状态管理 · 代码规范 · 安全 · 可维护性

---

## 审查结论

整体代码质量较高，架构分层清晰（IPC 驱动 + Zustand 状态 + 组件化 UI），注释充分，领域逻辑（番茄钟 / 白噪音 / 视频学习）封装合理。但存在以下突出问题：

1. **内存泄漏风险（Critical）**：多个 store 的 IPC 事件订阅使用模块级 `subscribed` 标志防重，从不取消订阅；应用生命周期内虽无影响，但 HMR / 未来多窗口场景下会泄漏。
2. **过度重渲染（High）**：大量组件直接解构整个 store 而非使用 selector，每秒 tick 触发全量重渲染；`NoiseControl` 滑块拖拽时 `emit()` 触发所有订阅组件刷新。
3. **代码重复（High）**：`OverlayApp` 与 `LearningAssistantDrawer` 中笔记逻辑、AI 流式问答逻辑几乎完全重复（约 200+ 行），未抽离为 hook 或 store。
4. **组件膨胀（Medium）**：`OverlayApp`（639 行）、`SettingsPage`（642 行）、`BiliModePage`（398 行）组件过大，职责过多，可维护性下降。
5. **状态冗余（Medium）**：`progressStore` 中 `records` 与 `all` 两份列表高度重叠，`englishStore` 流式更新逻辑可与 overlay 共享。

---

## 问题清单（按严重程度）

### 🔴 Critical（严重）

---

#### CR-01: focusStore IPC 事件订阅永不取消，存在内存泄漏

**文件**：`store/focusStore.ts:47-62`
**严重程度**：Critical
**维度**：性能 / 内存泄漏

**问题描述**：
`focusStore` 使用模块级变量 `subscribed` 防止重复订阅 IPC 事件，但订阅后从未提供取消订阅的方式。在单窗口应用生命周期内影响有限，但：

- HMR 热更新时模块重新执行，旧订阅不会被清理（`subscribed` 重置为 false 后再次订阅，导致同一事件多个监听器）
- 未来若引入多窗口 / 动态 store 创建，将产生明确的内存泄漏
- 与 `statsStore` 使用 `globalThis.__statsEventsSubscribed` 防 HMR 重复的模式不一致

**修复建议**：

1. 统一使用 `globalThis` 标志防 HMR 重复
2. 暴露 `destroy()` 方法用于清理订阅
3. 或使用 zustand `subscribeWithSelector` 中间件管理生命周期

**代码对比**：

```typescript
// 修改前
let subscribed = false

export const useFocusStore = create<FocusStore>((set, get) => ({
  // ...
  init: async () => {
    if (!subscribed) {
      subscribed = true
      window.api.on<TimerSnapshot>('timer:tick', (snap) => set({ snapshot: snap }))
      window.api.on<TimerSnapshot>('timer:complete', (snap) =>
        set({ snapshot: snap, justCompleted: true })
      )
    }
    // ...
  }
  // ...
}))
```

```typescript
// 修改后
const g = globalThis as unknown as { __focusEventsSubscribed?: boolean }
let unsubscribeFns: Array<() => void> = []

export const useFocusStore = create<FocusStore>((set, get) => ({
  // ...
  init: async () => {
    if (!g.__focusEventsSubscribed) {
      g.__focusEventsSubscribed = true
      unsubscribeFns.push(
        window.api.on<TimerSnapshot>('timer:tick', (snap) => set({ snapshot: snap })),
        window.api.on<TimerSnapshot>('timer:complete', (snap) =>
          set({ snapshot: snap, justCompleted: true })
        )
      )
    }
    // ...
  },
  destroy: () => {
    unsubscribeFns.forEach((fn) => fn())
    unsubscribeFns = []
    g.__focusEventsSubscribed = false
  }
  // ...
}))
```

---

#### CR-02: sessionStore 同 CR-01，IPC 订阅永不取消

**文件**：`store/sessionStore.ts:38-52`
**严重程度**：Critical
**维度**：性能 / 内存泄漏

**问题描述**：与 `focusStore` 完全相同的问题。`session:tick` 和 `session:complete` 事件订阅后永不取消。

**修复建议**：同 CR-01，统一 HMR 防重模式并暴露清理方法。

---

#### CR-03: englishStore chunk 事件订阅永不取消

**文件**：`store/englishStore.ts:64-105`
**严重程度**：Critical
**维度**：性能 / 内存泄漏

**问题描述**：
`englishStore` 有两个模块级订阅标志 `chunkSubscribed` 和 `settingsSubscribed`，均存在同样的问题。特别是 `ai:chunk` 事件会在每次流式问答时高频触发，泄漏的监听器会导致重复处理 chunk。

**修复建议**：同 CR-01。

---

### 🟠 High（高）

---

#### H-01: FocusPage 全量解构 useFocusStore，每秒 tick 触发全量重渲染

**文件**：`pages/FocusPage.tsx:25-38`
**严重程度**：High
**维度**：性能 / React 规范

**问题描述**：
`FocusPage` 直接从 `useFocusStore()` 解构出 10 个字段，意味着 store 任何变化（包括每秒一次的 `timer:tick` 更新 `snapshot`）都会触发该组件完整重渲染。番茄钟每秒 tick 是最高频的状态变化，应使用细粒度 selector 最小化重渲染范围。

**修复建议**：
使用 zustand selector 语法逐一订阅所需字段，或使用 `shallow` 比较。对于高频更新的 `snapshot`，考虑拆分为独立的派生 hook。

**代码对比**：

```typescript
// 修改前
function FocusPage(): JSX.Element {
  const {
    snapshot,
    alwaysOnTop,
    distraction,
    justCompleted,
    init,
    start,
    pause,
    resume,
    stop,
    setAlwaysOnTop,
    setDistraction,
    clearCompleted
  } = useFocusStore()
  // ...
}
```

```typescript
// 修改后
import { shallow } from 'zustand/shallow'

function FocusPage(): JSX.Element {
  const snapshot = useFocusStore((s) => s.snapshot)
  const alwaysOnTop = useFocusStore((s) => s.alwaysOnTop)
  const distraction = useFocusStore((s) => s.distraction)
  const justCompleted = useFocusStore((s) => s.justCompleted)
  const init = useFocusStore((s) => s.init)
  const start = useFocusStore((s) => s.start)
  const pause = useFocusStore((s) => s.pause)
  const resume = useFocusStore((s) => s.resume)
  const stop = useFocusStore((s) => s.stop)
  const setAlwaysOnTop = useFocusStore((s) => s.setAlwaysOnTop)
  const setDistraction = useFocusStore((s) => s.setDistraction)
  const clearCompleted = useFocusStore((s) => s.clearCompleted)
  // ...
}
```

> 注：更优方案是将 actions 提取到单独的静态引用中（zustand 官方推荐模式），避免每次 tick 都重新创建函数引用。

---

#### H-02: SessionTimerBar 全量解构 useSessionStore，每秒重渲染

**文件**：`components/SessionTimerBar.tsx:53-54`
**严重程度**：High
**维度**：性能 / React 规范

**问题描述**：与 H-01 相同模式，`SessionTimerBar` 全量解构 `useSessionStore()`，每秒 tick 触发重渲染。该组件在 视频学习页和英语学习页都存在，影响范围更广。

**修复建议**：同 H-01，使用细粒度 selector。

---

#### H-03: OverlayApp 与 LearningAssistantDrawer 大量重复逻辑

**文件**：`overlay/OverlayApp.tsx` 与 `components/LearningAssistantDrawer.tsx`
**严重程度**：High
**维度**：可维护性 / 代码重复

**问题描述**：
两个组件包含几乎完全相同的业务逻辑（约 200+ 行重复）：

1. **笔记逻辑**：500ms 防抖自动保存、切换笔记时 flush 草稿、新建/删除/重点标记/时间点标记 — 各写了一套
2. **AI 流式问答**：requestId 生成、chunk 事件订阅、历史消息截取、错误处理 — 各写了一套
3. **AI 回答记入笔记**：各写了一套
4. **状态管理方式不同**：OverlayApp 用 `useReducer`，LearningAssistantDrawer 用 `useState` + 独立变量，维护成本翻倍

**修复建议**：

1. 抽离 `useNotes()` hook 封装笔记状态 + 自动保存 + CRUD 操作
2. 抽离 `useBiliAiChat()` hook 封装流式问答逻辑
3. 或进一步将笔记和对话状态迁入 zustand store（与 `englishStore` 模式一致）

**代码对比（示意）**：

```typescript
// 新增 hooks/useNotes.ts
export function useNotes(context: BiliContext | null) {
  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const persistTimer = useRef<number | null>(null)

  // 500ms 防抖自动保存
  useEffect(() => {
    /* ... */
  }, [draft, dirty, editingId, context?.bvid])

  const selectNote = useCallback((entry: NoteEntry) => {
    /* ... */
  }, [])
  const deleteNote = useCallback((id: string) => {
    /* ... */
  }, [])
  const toggleKey = useCallback((entry: NoteEntry) => {
    /* ... */
  }, [])

  return { notes, draft, editingId, dirty, setDraft, selectNote, deleteNote, toggleKey, newNote }
}

// OverlayApp 和 LearningAssistantDrawer 中
const notes = useNotes(state.context)
```

---

#### H-04: NoiseEngine.emit() 在滑块拖拽时高频触发全量订阅刷新

**文件**：`audio/engine.ts:67-69, 94, 107, 152, 170, 179`
**严重程度**：High
**维度**：性能

**问题描述**：
`NoiseEngine` 是全局单例，使用发布-订阅模式通知 UI 更新。每次 `setMasterVolume` / `setTrackVolume` / `setSettings` / `playPreset` / `stopAll` 都会调用 `emit()`，通知所有订阅者。
在 `NoiseControl` 中，Slider 的 `onChange` 事件（拖拽时每帧触发）直接调用 `noiseEngine.setMasterVolume()` → `emit()` → 所有订阅该引擎的组件（包括 NoiseControl 自身）全部重渲染。
拖拽期间可能产生每秒 30+ 次重渲染，且包含 DOM 操作（Slider 渲染），性能损耗明显。

**修复建议**：

1. 引擎内部对 `emit()` 做防抖（如 `requestAnimationFrame` 节流）
2. 或 UI 层使用 `useSyncExternalStore` + 细粒度选择（如只订阅 `masterVolume` 变化）
3. 或迁移到 zustand store 管理音频状态，天然支持 selector

**代码对比**：

```typescript
// 修改前（engine.ts）
private emit(): void {
  for (const listener of this.listeners) listener()
}

setMasterVolume(value: number): void {
  // ... 设置音量
  this.emit()
}
```

```typescript
// 修改后
private emitScheduled = false

private emit(): void {
  if (this.emitScheduled) return
  this.emitScheduled = true
  requestAnimationFrame(() => {
    this.emitScheduled = false
    for (const listener of this.listeners) listener()
  })
}
```

---

#### H-05: OverlayApp 组件过大（639 行），职责过多

**文件**：`overlay/OverlayApp.tsx`
**严重程度**：High
**维度**：可维护性 / React 规范

**问题描述**：
`OverlayApp` 单文件 639 行，混合了以下职责：

- 窗口状态管理（expanded/minimized/hidden）
- AI 对话完整逻辑（流式问答、历史消息、记入笔记）
- 笔记完整逻辑（列表、编辑、自动保存、重点、时间点）
- 学习会话计时同步
- 学习进度心跳 tick（5 秒间隔）
- 视频操作（关闭、跳转、时间点标记）
- useReducer 包含 15 种 action type

违反了组件职责单一原则，修改任何一处功能都可能影响其他功能，测试困难。

**修复建议**：

1. AI 对话逻辑 → 抽离 `useBiliAiChat()` hook
2. 笔记逻辑 → 抽离 `useNotes()` hook
3. 进度心跳 → 抽离 `useSessionTick()` hook
4. 头部操作栏 → 抽离 `OverlayHeader` 组件
5. 页签切换逻辑 → 抽离 `OverlayTabs` 组件

参考：项目特定规则 P1 — 组件超过 300 行未拆分子组件。

---

#### H-06: SettingsPage 组件过大（642 行），表单逻辑耦合

**文件**：`pages/SettingsPage.tsx`
**严重程度**：High
**维度**：可维护性 / React 规范

**问题描述**：
`SettingsPage` 单文件 642 行，包含 7 个设置卡片的全部表单逻辑：

- 强制控制（锁定级别、到点动作、恢复码）
- 番茄钟参数（4 个时长配置）
- 视频学习模式（严格度、自动全屏）
- 学习会话（遮罩开关）
- AI 设置（5 项配置）
- 白噪音（默认预设）
- 数据管理（备份/恢复 + 自动备份 5 项配置）
- 匿名统计 + 反馈

每个配置项的 `update()` 方法都走同一个保存-重新加载流程，代码模式高度重复。

**修复建议**：

1. 按设置分组拆分为子组件（`LockSettings` / `PomodoroSettings` / `AiSettings` / `BackupSettings` 等）
2. 抽离通用的 `useSetting<T>(key, defaultValue)` hook 封装读取/写入/loading 状态
3. 或使用 antd Form 组件统一管理表单状态

---

#### H-07: EnglishModePage 与 englishStore 中都有 MessageItem 组件及词汇/语法操作逻辑

**文件**：`pages/EnglishModePage.tsx:65-137` 与 `store/englishStore.ts`
**严重程度**：High
**维度**：可维护性 / 状态管理

**问题描述**：
`EnglishModePage` 中定义了 `MessageItem` 组件，内部直接调用 `useEnglishStore()` 的 `addVocab` / `addGrammar` 方法，并包含"提取单词"、"去除 Markdown"等辅助函数。
同时 overlay 的 `ChatPane` 组件也有类似的"记入笔记"操作，但走的是完全不同的路径（`onSaveToNotes` prop → 父组件处理 → notes API）。

英语模式的 AI 对话与 视频学习模式的 AI 对话虽然共享 `ai:chunk` 事件，但各自维护一套消息状态和流式处理逻辑，数据流不统一。

**修复建议**：

1. 统一 AI 对话的 store 层：将 `englishStore` 扩展为通用的 `useAiChatStore`，支持不同场景（英语 / 视频学习 / 通用）
2. `MessageItem` 组件移到 `components/` 目录复用
3. 词汇/语法提取逻辑作为 store 的 action 方法

---

### 🟡 Medium（中）

---

#### M-01: progressStore 中 records 与 all 两份列表高度冗余

**文件**：`store/progressStore.ts:30-32`
**严重程度**：Medium
**维度**：状态管理

**问题描述**：
`progressStore` 同时维护 `records`（筛选后的列表）和 `all`（未筛选全量）两份数据。两者内容高度重叠，每次 `applyTick` / `markDone` / `updateRecord` 等操作都需要同时更新两份列表，增加了出错概率和内存占用。

**修复建议**：
考虑仅维护 `all` 一份全量数据，`records` 通过派生（selector + memo）计算：

```typescript
// 方案：使用 zustand 派生选择器
import { create } from 'zustand'
import { useMemo } from 'react'

// 在组件中
const records = useProgressStore((s) => {
  const { all, filter } = s
  // 按 filter 筛选排序
  return applyFilter(all, filter)
}, shallow)
```

> 注：若列表量大（>500 条）且筛选频繁，保留双列表可能是有意的性能优化。建议添加注释说明设计决策。

---

#### M-02: formatMs / formatClock 等时间格式化函数多处重复

**文件**：

- `pages/FocusPage.tsx:14-22`（formatMs）
- `components/SessionTimerBar.tsx:31-39`（formatMs）
- `overlay/OverlayApp.tsx:630-637`（formatClock）
- `overlay/ProgressRing.tsx`（formatSeconds，未读但被引用）

**严重程度**：Medium
**维度**：代码规范 / 可维护性

**问题描述**：
毫秒/秒格式化函数在多个文件中重复定义，逻辑基本一致（都是 `h:mm:ss` / `mm:ss` 格式），但实现细节略有差异（有的用 `Math.ceil`，有的用 `Math.floor`；有的处理小时阈值不同），可能导致显示不一致。

**修复建议**：
抽离到 `utils/time.ts` 统一管理：

```typescript
// utils/time.ts
export function formatMs(ms: number): string {
  /* ... */
}
export function formatSeconds(s: number): string {
  /* ... */
}
export function formatClock(totalSeconds: number): string {
  /* ... */
}
```

---

#### M-03: englishStore.ask 中流式更新与最终回复存在竞态

**文件**：`store/englishStore.ts:152-161`
**严重程度**：Medium
**维度**：状态管理 / 正确性

**问题描述**：
`ask` 方法中，AI 回复通过两条路径更新消息：

1. `ai:chunk` 事件（流式增量）— 由 `init()` 中注册的全局监听器处理
2. `window.api.ai.englishAsk()` 返回值（最终完整内容）— 由 `ask` 方法自身处理

两条路径都修改同一条消息，可能存在竞态：

- 若流式 chunk 先到达并完成（`done=true`），设置 `streaming: false`
- 随后 `englishAsk()` 返回，再次设置 `streaming: false` 并覆盖 content
- 正常情况下两者内容一致，但如果 chunk 事件丢失或延迟，最终内容由返回值保证，这是有意的兜底设计

然而，`isStreaming` 状态在两处分别设置，chunk 事件先完成会先设为 `false`，然后 `ask` 的 finally 又设一次。更重要的是，chunk 监听器是全局的，如果同时有两个会话（虽然当前 UI 阻止了），会互相干扰。

**修复建议**：
明确以其中一条路径为准。建议以 `englishAsk()` 返回值为最终权威，chunk 仅用于渐进式显示，且在 `ask` 方法内部注册和清理 chunk 监听器，而非全局注册：

```typescript
ask: async (scenario, message, word) => {
  // ...
  const offChunk = window.api.on('ai:chunk', (chunk) => {
    if (chunk.requestId !== requestId) return
    // 仅更新 content，不管理 isStreaming 终态
  })
  try {
    const reply = await window.api.ai.englishAsk(question)
    // 最终内容 + 状态由这里统一设置
  } finally {
    offChunk()
  }
}
```

---

#### M-04: MarkdownView 未显式禁用 HTML（默认安全，但应明确）

**文件**：`components/MarkdownView.tsx:1-23`
**严重程度**：Medium
**维度**：安全

**问题描述**：
`react-markdown` 默认不渲染原始 HTML（`rehype-raw` 未启用时），所以默认是安全的，不存在 XSS 风险。但代码中没有明确注释说明这一点，且使用了 `remarkGfm` 插件，未来维护者可能误加 `rehype-raw` 引入安全风险。

AI 生成的内容可能被注入恶意 HTML / JavaScript，安全边界需要明确。

**修复建议**：
添加注释明确说明安全策略，并考虑显式设置 `disallowedElements` 作为纵深防御：

```typescript
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  // 安全策略：不渲染原始 HTML，所有 HTML 标签以纯文本显示
  // AI 生成内容不可信，禁用 <script>/<iframe>/<img> 等
  disallowedElements={['script', 'iframe', 'style', 'link', 'video', 'audio', 'form', 'input', 'button']}
  unwrapDisallowed
  components={{
    // ...
  }}
>
  {content}
</ReactMarkdown>
```

---

#### M-05: BiliModePage 直接使用 localStorage 存储 autoFullscreen

**文件**：`pages/BiliModePage.tsx:66-69, 88-91`
**严重程度**：Medium
**维度**：状态管理 / 数据持久化

**问题描述**：
`autoFullscreen` 配置使用 `localStorage` 存储（key: `bili.autoFullscreen`），但 视频学习模式的其他配置（`strictness`）走 `settings store`（electron-store）。同属 视频学习模式的配置分散在两个存储系统中，不一致。

同时 `SettingsPage` 中也有 `autoFullscreen` 设置项（`bili.autoFullscreen`），但 `BiliModePage` 并未读取该设置，而是读自己的 localStorage。两者可能产生冲突。

**修复建议**：
统一使用 `settings store` 管理 `autoFullscreen`，与 `strictness` 保持一致：

```typescript
// 修改前
const [autoFullscreen, setAutoFullscreen] = useState<boolean>(() => {
  const saved = localStorage.getItem('bili.autoFullscreen')
  return saved === null ? true : saved === '1'
})

// 修改后
const [autoFullscreen, setAutoFullscreen] = useState(true)
useEffect(() => {
  void window.api.settings.get().then((s) => setAutoFullscreen(s.bili.autoFullscreen))
}, [])
```

---

#### M-06: 多个 useEffect 依赖不全，使用 eslint-disable 绕过

**文件**：

- `overlay/OverlayApp.tsx:293-294`（笔记自动保存 effect）
- `overlay/OverlayApp.tsx:351-352`（进度心跳 effect）
- `components/LearningAssistantDrawer.tsx:109-110`（笔记自动保存 effect）
- `components/LearningAssistantDrawer.tsx:299-300`（paste 监听 effect）

**严重程度**：Medium
**维度**：React 规范

**问题描述**：
多处 `useEffect` 使用 `// eslint-disable-next-line react-hooks/exhaustive-deps` 绕过依赖检查。这些 effect 中引用了外部 state（如 `state.noteDraft`、`state.editingNoteId`、`context` 等），但未列入依赖数组。

当前通过 `stateRef` 模式（OverlayApp）或 setState 函数式更新（LearningAssistantDrawer）部分规避了闭包过期问题，但这种模式脆弱，后续维护时容易引入 bug。

**修复建议**：

1. 笔记自动保存逻辑 → 抽离为自定义 hook，使用 ref 保存最新草稿
2. 进度心跳 → 依赖项应完整列出，使用 `useCallback` 包裹回调
3. 作为兜底，所有绕过 lint 的地方都应添加详细注释说明原因

---

#### M-07: noiseEngine 白噪音设置使用 localStorage，与全局设置系统不一致

**文件**：`audio/presets.ts:8-27`
**严重程度**：Medium
**维度**：状态管理 / 数据持久化

**问题描述**：
白噪音设置（音量、当前预设、联动配置等）使用 `localStorage` 存储（key: `noise.settings`），而应用其他设置都走 `electron-store`（通过 `window.api.settings`）。

注释中提到"M1 用 localStorage；后续 storage 模块接入后迁移 electron-store"，说明这是一个已知的技术债务。`SettingsPage` 中有 `noisePreset` 设置项，但与 `noiseEngine` 的 `settings.preset` 是两套独立的数据，互不同步。

**修复建议**：
迁移至 electron-store，与全局设置系统统一。`noiseEngine` 初始化时从 `window.api.settings.get()` 读取，变更时通过 `window.api.settings.set()` 持久化。

---

#### M-08: statsStore 中 loadAll 的缓存策略可能导致数据不一致

**文件**：`store/statsStore.ts:56-78`
**严重程度**：Medium
**维度**：状态管理 / 正确性

**问题描述**：
`loadAll` 方法按粒度缓存数据：`trend` 按 `trendDays` 缓存，`modes` 和 `heatmap` 加载后永久缓存（直到 `onStudyCompleted` 失效）。

问题：当用户切换天数范围（如从 14 天切到 30 天）时，`modes` 和 `heatmap` 不会重新加载（因为 `modes !== null`）。但 `modes`（模式对比）和 `heatmap`（时段热力图）的数据范围应该与趋势图保持一致吗？从代码看，`modeCompare()` 和 `heatmap()` 似乎返回全量数据，不受天数影响。如果是这样，缓存策略是合理的，但应添加注释明确说明。

如果模式对比和热力图也是按天数范围的，则当前缓存逻辑有 bug。

**修复建议**：
添加注释明确 `modes` 和 `heatmap` 是全量数据还是按天数据，避免后续维护者误解。

---

### 🟢 Low（低）

---

#### L-01: CoverImage 右键复制封面图链接使用 navigator.clipboard 需要权限

**文件**：`components/CoverImage.tsx:50-53`
**严重程度**：Low
**维度**：安全 / 兼容性

**问题描述**：
`onContextMenu` 中调用 `navigator.clipboard.writeText(fallbackSrc)` 复制封面链接。在 Electron 渲染进程中，`navigator.clipboard` API 在非安全上下文（`file://` 协议）中可能不可用，且静默失败。

**修复建议**：
使用 Electron 的 `clipboard` API（通过 preload 暴露）或添加错误处理：

```typescript
onContextMenu={async (e) => {
  e.preventDefault()
  try {
    await navigator.clipboard.writeText(fallbackSrc)
  } catch {
    // 降级：选中 + execCommand('copy') 或通过 IPC 调用主进程 clipboard
  }
}}
```

---

#### L-02: chime.ts 每次播放都新建 AudioContext，未复用

**文件**：`audio/chime.ts:5-28`
**严重程度**：Low
**维度**：性能

**问题描述**：
每次调用 `playChime()` 都新建一个 `AudioContext`，播放完成后 3 秒关闭。番茄钟到点时调用一次，影响不大。但如果用户快速连续触发（如测试场景），可能创建多个 AudioContext 实例。

浏览器对 AudioContext 数量有限制（通常 6 个），超过后新建会失败。

**修复建议**：
复用单例 AudioContext，或与 `noiseEngine` 共享：

```typescript
let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

export function playChime(): void {
  try {
    const ctx = getCtx()
    // ... 使用 ctx 播放
  } catch {
    /* ... */
  }
}
```

---

#### L-03: HomePage 中 focusStart 和 sessionStart 未使用 selector

**文件**：`pages/HomePage.tsx:14-15`
**严重程度**：Low
**维度**：性能 / React 规范

**问题描述**：

```typescript
const focusStart = useFocusStore((s) => s.start)
const sessionStart = useSessionStore((s) => s.start)
```

虽然使用了 selector 语法，但每次 store 变化时都会返回新的函数引用（因为 `start` 是 store 内的箭头函数），导致不必要的重渲染。

**修复建议**：
使用 zustand 官方推荐的静态 action 模式，或使用 `useStore` 的第三个参数比较函数：

```typescript
const focusStart = useFocusStore(
  (s) => s.start,
  () => true
) // 永远不因为 action 变化而重渲染
```

---

#### L-04: DurationConfigModal 中 state 未在关闭时重置

**文件**：`components/DurationConfigModal.tsx:24, 26`
**严重程度**：Low
**维度**：React 规范

**问题描述**：
`DurationConfigModal` 使用 `destroyOnClose` 但 state（`custom`）保存在组件内。由于 `destroyOnClose` 会卸载组件，下次打开时会重新初始化 `custom = defaultMin`，这是期望行为。

但 `mode` 从 `null` 变为有效值时，组件从 `return <></>` 变为渲染 Modal，此时 `custom` 仍是旧值（因为组件没卸载，只是条件渲染）。如果用户上次选了 45 分钟的 focus 模式，下次打开 bili 模式时会显示 45 分钟而不是默认值。

**修复建议**：
在 `mode` 变化时重置 `custom`：

```typescript
useEffect(() => {
  if (mode) setCustom(defaultMin)
}, [mode, defaultMin])
```

---

#### L-05: App.tsx 中 page state 与 URL hash 不同步

**文件**：`App.tsx:39-49`
**严重程度**：Low
**维度**：可维护性

**问题描述**：
`App.tsx` 监听了 `hashchange` 事件并维护 `route` state，但 `page` state 仅通过菜单点击更新，与 URL hash 不同步。用户直接修改 URL hash 不会切换页面（除了 `#overlay`）。

当前设计似乎是有意的（hash 仅用于 overlay 路由），但 `route` state 只用来判断是否显示 overlay，命名和结构容易让人以为 hash 驱动全部路由。

**修复建议**：
重命名 `route` 为 `hashRoute` 或 `isOverlay`，明确其用途：

```typescript
const [isOverlay, setIsOverlay] = useState(() => window.location.hash === '#overlay')

useEffect(() => {
  const onHashChange = (): void => setIsOverlay(window.location.hash === '#overlay')
  window.addEventListener('hashchange', onHashChange)
  return () => window.removeEventListener('hashchange', onHashChange)
}, [])

if (isOverlay) return <OverlayApp />
```

---

## 其他观察与建议

### 正向亮点

1. **架构清晰**：IPC 驱动 + Zustand 状态 + 组件分层，主从关系明确（主进程为事实源，渲染层为快照同步）
2. **注释质量高**：几乎每个模块都有详细的设计说明，标注了方案编号（如"方案 2.8"、"M1"、"F-4"），便于追溯设计文档
3. **错误处理完善**：IPC 调用、音频解码、API 请求等都有 try/catch 和降级逻辑
4. **防抖/节流意识好**：笔记自动保存 500ms 防抖、统计加载 request 令牌防竞态、ScrollArea 指标对比跳渲染
5. **无障碍支持**：NotesPane 键盘导航、ARIA 属性、role 属性等都有考虑

### 架构改进建议

1. **统一 AI 对话层**：`englishStore`、`OverlayApp`、`LearningAssistantDrawer` 三套 AI 对话逻辑 → 统一为 `useAiChatStore`
2. **统一笔记层**：overlay 和 drawer 两套笔记逻辑 → 统一为 `useNotesStore` 或 `useNotes()` hook
3. **音频状态 Zustand 化**：`NoiseEngine` 的订阅模式与 React 生态不太契合 → 迁移到 zustand store，天然支持 selector 和 devtools
4. **设置系统统一**：白噪音设置、视频学习 autoFullscreen 等 localStorage 项 → 全部迁入 electron-store
5. **引入测试**：核心逻辑（CrossfadeLoop、时间格式化、store reducer）建议添加单元测试

---

## 问题统计

| 严重程度 | 数量   |
| -------- | ------ |
| Critical | 3      |
| High     | 7      |
| Medium   | 8      |
| Low      | 5      |
| **合计** | **23** |

---

_报告生成时间：2026-08-22_
