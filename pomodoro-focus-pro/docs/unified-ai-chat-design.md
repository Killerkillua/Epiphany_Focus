# 统一 AI 对话数据流 + 四模式 Prompt 职责设计方案

> 番茄专注 Pro · 技术方案 · 2026-08-22

---

## 一、现状问题诊断

### 1.1 三套独立的消息状态管理

| 消费方                                    | 状态管理                  | 消息类型      | 流式订阅                     | 请求方法                     |
| ----------------------------------------- | ------------------------- | ------------- | ---------------------------- | ---------------------------- |
| 英语模式 `EnglishModePage`                | Zustand `useEnglishStore` | `ChatMessage` | 全局 `globalThis` 标志防重复 | `window.api.ai.englishAsk()` |
| B站悬浮面板 `OverlayApp`                  | `useReducer`              | `ChatMsg`     | 每次请求注册/取消            | `window.api.ai.biliAsk()`    |
| B站学习助手抽屉 `LearningAssistantDrawer` | `useState`                | `ChatMsg`     | 每次请求注册/取消            | `window.api.ai.biliAsk()`    |

### 1.2 两种消息类型定义

```typescript
// src/renderer/src/store/englishStore.ts
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources: AiSource[] // RAG 来源
  streaming?: boolean
  queryWord?: string // 词汇一键入本
}

// src/renderer/src/overlay/ChatPane.tsx
interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  welcome?: boolean // 欢迎语（不显示操作按钮）
}
```

> **问题**：字段不统一——英语模式有 `sources` / `queryWord`，B站模式有 `welcome`。两个类型无法互换，导致组件无法复用。

### 1.3 MessageItem 组件重复定义

| 组件                | 位置                       | 功能                                                                  |
| ------------------- | -------------------------- | --------------------------------------------------------------------- |
| `MessageItem`       | `EnglishModePage.tsx` 内联 | MarkdownView + SourcesPanel + 流式光标 + "加入生词本"/"语法要点" 按钮 |
| `ChatPane` 内联渲染 | `ChatPane.tsx`             | MarkdownView + 流式 + "记入笔记" 按钮                                 |

> **问题**：两处消息渲染逻辑 80% 相同（MarkdownView、流式光标、用户/助手气泡），但操作按钮各自硬编码，无法通过 props 注入。

### 1.4 四个英语模式 Prompt 现状

当前采用 **"1 个通用 System Prompt + 4 个场景模板追加到用户消息前"** 的分层架构：

```typescript
// src/main/ai/prompts.ts 现状

SYSTEM_PROMPT         → 所有场景共用，定义通用 TESOL 教师角色
SCENARIO_TEMPLATES    → 短指令追加在用户消息前（如 "【场景：语法讲解】请按...结构讲解"）
COT_INSTRUCTION       → 复杂场景追加 CoT 指令

buildMessages() 组装：
  system: SYSTEM_PROMPT + 参考资料
  user:   SCENARIO_TEMPLATES[scenario] + 查询词 + 用户消息 + COT_INSTRUCTION
```

> **不足**：场景模板只是追加在用户消息前的短指令，**没有为每个模式定义独立角色、核心职责、输出格式约束和交互规则**。切换模式时，AI 的角色定位、输出风格、交互深度没有本质变化。

---

## 二、设计目标

1. **统一消息类型**：一套 `ChatMessage` 类型覆盖英语/B站所有场景，字段可选化兼容差异
2. **统一对话 Hook**：一个 `useAiChat` hook 替代 Zustand store / useReducer / useState 三套实现
3. **统一 MessageItem 组件**：移入 `components/`，通过 `actions` props 注入模式特有按钮
4. **四模式独立 Prompt**：每个英语 AI 模式拥有独立的 System Prompt，定义角色、职责、输出格式、交互规则

---

## 三、架构对比：改造前 vs 改造后

### 3.1 改造前（当前）

```
渲染层
┌─────────────────┐  ┌──────────────────────┐  ┌────────────────────────────────┐
│ EnglishModePage  │  │ OverlayApp            │  │ LearningAssistantDrawer        │
│                 │  │                      │  │                                │
│ Zustand store   │  │ useReducer           │  │ useState                      │
│ ChatMessage     │  │ ChatMsg              │  │ ChatMsg                        │
│                 │  │                      │  │                                │
│ MessageItem     │  │ ChatPane(内联渲染)    │  │ ChatPane(复用)                 │
│ (内联定义)       │  │                      │  │                                │
└────────┬────────┘  └──────────┬───────────┘  └────────────┬───────────────────┘
         │ englishAsk()         │ biliAsk()                 │ biliAsk()
         │                      │                           │
         ▼                      ▼                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EnglishGateway (gateway.ts)                  │
│  profile='english' (temp=0.7)   |   profile='bili' (temp=0.5)  │
│  SYSTEM_PROMPT + SCENARIO_TEMPLATES |   BILI_STUDY_PROMPT       │
└─────────────────────────────────────────────────────────────────┘

问题：3 套状态管理 × 2 种消息类型 × 2 处消息渲染 × 1 个追加式 Prompt 体系
```

### 3.2 改造后（目标）

```
渲染层
┌─────────────────┐  ┌──────────────────────┐  ┌────────────────────────────────┐
│ EnglishModePage  │  │ OverlayApp            │  │ LearningAssistantDrawer        │
│                 │  │                      │  │                                │
│ useAiChat({     │  │ useAiChat({          │  │ useAiChat({                    │
│   profile:'engl'│  │   profile:'bili',    │  │   profile:'bili',              │
│   scenario      │  │   context:{...}      │  │   context:{...}                │
│ })              │  │ })                   │  │ })                             │
│                 │  │                      │  │                                │
│ MessageItem     │  │ MessageItem          │  │ MessageItem                    │
│ (共享组件)       │  │ (共享组件)            │  │ (共享组件)                      │
│ actions=生词/语法│  │ actions=记入笔记      │  │ actions=记入笔记                │
└────────┬────────┘  └──────────┬───────────┘  └────────────┬───────────────────┘
         │                      │                           │
         └──────────┬───────────┘───────────────────────────┘
                    │ 统一 useAiChat hook
                    ▼
         ┌──────────────────────────┐
         │  window.api.ai.englishAsk │  /  window.api.ai.biliAsk
         └──────────┬───────────────┘
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EnglishGateway (gateway.ts)                  │
│  profile='english': SCENARIO_PROMPTS[scenario]  (4 模式独立 Prompt)│
│  profile='bili':    BILI_STUDY_PROMPT                           │
└─────────────────────────────────────────────────────────────────┘

统一：1 个 hook × 1 种消息类型 × 1 个 MessageItem × 4 模式独立 Prompt
```

---

## 四、统一数据流方案

### 4.1 统一消息类型 `ChatMessage`

在 `src/shared/ai.ts` 中定义唯一消息类型，取代 `ChatMessage`（englishStore）和 `ChatMsg`（ChatPane）：

```typescript
// src/shared/ai.ts — 新增

/** 统一对话消息（英语模式 / B站模式共用） */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** RAG 参考来源（英语模式词汇/语法场景） */
  sources?: AiSource[]
  /** 是否正在流式输出 */
  streaming?: boolean
  /** 词汇场景关联的查询词（英语模式一键入本） */
  queryWord?: string
  /** 欢迎语等系统消息：不显示操作按钮（B站模式） */
  welcome?: boolean
}
```

> **设计**：所有字段可选化（`?`），英语模式用到 `sources` / `queryWord`，B站模式用到 `welcome`，互不冲突。

### 4.2 统一对话 Hook `useAiChat`

在 `src/renderer/src/hooks/useAiChat.ts` 中新建，替代三套状态管理：

```typescript
// src/renderer/src/hooks/useAiChat.ts — 新建

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiScenario, AiStreamChunk, AiSource, ChatMessage } from '../../../shared/ai'
import type { AiMessage } from '../../../shared/bili'
import { extractErrorMessage } from '../utils/errorMessage'

type AiProfile = 'english' | 'bili'

interface BiliContext {
  topic?: string
  videoTitle?: string
  bvid?: string
}

interface UseAiChatOptions {
  profile: AiProfile
  /** 英语模式场景（profile='english' 时必填） */
  scenario?: AiScenario
  /** B站模式学习上下文（profile='bili' 时使用） */
  context?: BiliContext
}

interface UseAiChatReturn {
  messages: ChatMessage[]
  isStreaming: boolean
  /** 发送消息（英语模式走 englishAsk，B站走 biliAsk） */
  ask: (message: string, opts?: { word?: string }) => Promise<void>
  /** 清空消息（切换模式/场景时调用） */
  clear: () => void
  /** 设置欢迎语 */
  setWelcome: (content: string) => void
}

export function useAiChat(options: UseAiChatOptions): UseAiChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const activeRequestId = useRef<string | null>(null)

  // 流式事件订阅：按 requestId 过滤，只处理当前活跃请求的增量
  useEffect(() => {
    const off = window.api.on<AiStreamChunk>('ai:chunk', (chunk) => {
      if (chunk.requestId !== activeRequestId.current) return
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== chunk.requestId) return m
          if (chunk.done) {
            return {
              ...m,
              content: chunk.content ?? m.content,
              sources: chunk.sources ?? m.sources,
              streaming: false
            }
          }
          return { ...m, content: m.content + chunk.delta }
        })
      )
      if (chunk.done) {
        activeRequestId.current = null
        setIsStreaming(false)
      }
    })
    return () => {
      off()
    }
  }, [])

  const ask = useCallback(
    async (message: string, opts?: { word?: string }) => {
      const trimmed = message.trim()
      if (!trimmed || isStreaming) return

      const requestId = crypto.randomUUID()
      activeRequestId.current = requestId

      // 构建多轮历史（最近 8 轮，过滤 streaming 占位）
      const history = messages
        .filter(
          (m) => !m.streaming && (m.role === 'user' || m.role === 'assistant') && m.content.trim()
        )
        .slice(-8)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      // 追加用户消息 + 助手占位消息
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: trimmed, sources: [] },
        {
          id: requestId,
          role: 'assistant',
          content: '',
          sources: [],
          streaming: true,
          queryWord: opts?.word ?? trimmed
        }
      ])
      setIsStreaming(true)

      try {
        if (options.profile === 'english') {
          const reply = await window.api.ai.englishAsk({
            requestId,
            scenario: options.scenario ?? 'free',
            message: trimmed,
            word: opts?.word,
            history
          })
          setMessages((prev) =>
            prev.map((m) =>
              m.id === requestId && m.streaming
                ? { ...m, content: reply.content, sources: reply.sources, streaming: false }
                : m
            )
          )
        } else {
          const reply = await window.api.ai.biliAsk({
            requestId,
            message: trimmed,
            context: options.context,
            history: history as AiMessage[]
          })
          setMessages((prev) =>
            prev.map((m) =>
              m.id === requestId && m.streaming
                ? { ...m, content: reply.content, streaming: false }
                : m
            )
          )
        }
      } catch (err) {
        const friendly = extractErrorMessage(err)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === requestId
              ? { ...m, content: m.content || `⚠️ ${friendly}`, streaming: false }
              : m
          )
        )
      } finally {
        activeRequestId.current = null
        setIsStreaming(false)
      }
    },
    [messages, isStreaming, options]
  )

  const clear = useCallback(() => {
    setMessages([])
    activeRequestId.current = null
    setIsStreaming(false)
  }, [])

  const setWelcome = useCallback((content: string) => {
    setMessages([{ id: 'welcome', role: 'assistant', content, welcome: true }])
  }, [])

  return { messages, isStreaming, ask, clear, setWelcome }
}
```

#### Hook 设计要点

| 维度         | 实现                      | 说明                                                                              |
| ------------ | ------------------------- | --------------------------------------------------------------------------------- |
| 状态管理     | `useState`                | 每个消费者独立实例，无全局 store 竞争                                             |
| 流式订阅     | `useEffect` + `useRef`    | 组件 mount 时订阅一次，unmount 时自动取消；`activeRequestId` 过滤确保增量路由正确 |
| HMR 安全     | `useEffect` cleanup       | 热更新时自动取消旧订阅，新组件实例干净订阅                                        |
| 多轮历史     | 从 `messages` 取最近 8 轮 | 英语 `conversation`/`free` 和 B站模式均自动携带                                   |
| profile 分流 | `options.profile`         | `'english'` 走 `englishAsk`，`'bili'` 走 `biliAsk`                                |

### 4.3 统一 `MessageItem` 组件

从 `EnglishModePage.tsx` 内联提取为独立组件 `src/renderer/src/components/MessageItem.tsx`：

```typescript
// src/renderer/src/components/MessageItem.tsx — 新建

import { Button } from 'antd'
import type { ReactNode } from 'react'
import MarkdownView from './MarkdownView'
import SourcesPanel from './SourcesPanel'
import ScrollArea, { type ScrollAreaHandle } from './ScrollArea'
import type { ChatMessage } from '../../../shared/ai'

interface MessageListProps {
  messages: ChatMessage[]
  isStreaming: boolean
  listRef?: React.RefObject<ScrollAreaHandle>
  /** 模式特有的操作按钮（注入到每条助手消息底部） */
  actions?: (msg: ChatMessage) => ReactNode
  /** 自定义 CSS 类名前缀 */
  classNamePrefix?: 'chat' | 'overlay'
}

export function MessageList({
  messages, isStreaming, listRef, actions, classNamePrefix = 'chat'
}: MessageListProps): JSX.Element {
  // 自动滚底
  useEffect(() => {
    const vp = listRef?.current?.viewport
    if (vp) vp.scrollTop = vp.scrollHeight
  }, [messages, isStreaming, listRef])

  const prefix = classNamePrefix === 'overlay' ? 'overlay-msg' : 'chat-msg'

  return (
    <ScrollArea className={`${prefix}-log`} ref={listRef}>
      {messages.map((msg) => (
        <div key={msg.id} className={`${prefix} ${msg.role === 'user' ? 'user' : 'assistant'}`}>
          <div className={`${prefix}-bubble`}>
            {msg.role === 'user' ? (
              <div className={`${prefix}-user-text`}>{msg.content}</div>
            ) : (
              <>
                {msg.content ? (
                  <MarkdownView content={msg.content} />
                ) : (
                  <span className={`${prefix}-thinking`}>思考中…</span>
                )}
                {msg.streaming && <span className={`${prefix}-cursor`} />}
                {msg.sources && msg.sources.length > 0 && <SourcesPanel sources={msg.sources} />}
                {!msg.streaming && msg.content && !msg.welcome && actions && (
                  <div className={`${prefix}-actions`}>{actions(msg)}</div>
                )}
              </>
            )}
          </div>
        </div>
      ))}
      {isStreaming && messages.every((m) => !m.streaming) && (
        <div className={`${prefix} assistant ${prefix}-typing`}>思考中…</div>
      )}
    </ScrollArea>
  )
}
```

#### 各消费方注入 actions

```typescript
// EnglishModePage — 注入"加入生词本"/"语法要点"
<MessageList
  messages={messages}
  isStreaming={isStreaming}
  listRef={listRef}
  actions={(msg) => (
    <>
      <Button size="small" type="text" icon={<BookOutlined />} onClick={() => handleAddVocab(msg)}>加入生词本</Button>
      <Button size="small" type="text" icon={<BulbOutlined />} onClick={() => handleAddGrammar(msg)}>语法要点</Button>
    </>
  )}
/>

// OverlayApp / LearningAssistantDrawer — 注入"记入笔记"
<MessageList
  messages={messages}
  isStreaming={isStreaming}
  listRef={logRef}
  classNamePrefix="overlay"
  actions={(msg) => (
    <Button type="text" size="small" icon={<SaveOutlined />} onClick={() => saveToNotes(msg)}>记入笔记</Button>
  )}
/>
```

### 4.4 `englishStore` 瘦身

Zustand store 仅保留 **非对话状态**（配置/用量/生词本/语法要点），对话逻辑移入 `useAiChat`：

```typescript
// src/renderer/src/store/englishStore.ts — 改造后

interface EnglishStore {
  // 删除: messages, isStreaming, ask, init(chunk订阅), destroy
  // 保留:
  config: AiConfig
  usage: AiUsage
  vocab: VocabEntry[]
  grammar: GrammarPoint[]
  init: () => Promise<void> // 仅拉取 config/usage/vocab/grammar + settings 订阅
  refreshConfig: () => Promise<void>
  refreshLists: () => Promise<void>
  addVocab: (payload: AddVocabPayload) => Promise<void>
  deleteVocab: (id: number) => Promise<void>
  addGrammar: (payload: AddGrammarPayload) => Promise<void>
  deleteGrammar: (id: number) => Promise<void>
}
```

---

## 五、四个英语 AI 模式 Prompt 职责设计

### 5.1 Prompt 架构升级

**改造前**：1 个通用 `SYSTEM_PROMPT` + 4 个场景模板追加到用户消息前

**改造后**：4 个独立 `SCENARIO_PROMPTS` 直接作为 system 消息，每个模式拥有完整角色定义

```typescript
// src/main/ai/prompts.ts — 改造后

// 删除: SYSTEM_PROMPT, SCENARIO_TEMPLATES, COT_INSTRUCTION
// 新增: 4 个独立模式 Prompt + 1 个自由提问 Prompt

export const SCENARIO_PROMPTS: Record<AiScenario, string> = {
  grammar: GRAMMAR_PROMPT, // 语法讲解
  vocabulary: VOCABULARY_PROMPT, // 词汇查询
  conversation: CONVERSATION_PROMPT, // 对话练习
  writing: WRITING_PROMPT, // 写作批改
  free: FREE_PROMPT // 自由提问
}

// buildMessages 改造：直接选用对应模式的 system prompt
export function buildMessages(
  question: AiQuestion,
  sources: AiSource[]
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const systemPrompt = SCENARIO_PROMPTS[question.scenario]
  const system =
    systemPrompt +
    (sources.length > 0
      ? `\n\n# 参考资料（已检索权威词典，回答时必须引用并标注来源链接）\n${formatSources(sources)}`
      : '')
  const wordLine = question.word ? `查询词：${question.word}\n` : ''

  return [
    { role: 'system', content: system },
    ...sanitizeHistory(question.history),
    { role: 'user', content: `${wordLine}${question.message}` }
  ]
}
```

### 5.2 模式一：语法讲解（Grammar）

```
# 角色
你是「语法讲解」模式的 AI 助教，一位专注于英语语法教学的语言学专家，
精通英语时态、句法结构、词形变化及中国学习者的常见语法误区。

# 核心职责
1. 讲解语法规则、时态用法、句型结构
2. 分析用户句子中的语法错误，指明错误类型并给出修正方案
3. 通过大量例句对比帮助理解规则边界
4. 针对中国学习者常见误区提供专项纠正

# 输出格式（严格遵守）
## 规则摘要
1-2 句英文概述该语法规则

## 详细讲解
分步中文解析，由浅入深，引用规则逻辑

## 例句（至少 5 条）
- [英文例句] → [中文翻译]
- [英文例句] → [中文翻译]
（覆盖肯定句、否定句、疑问句等不同形式）

## 中国学习者常见错误
| 错误表达 | 正确表达 | 错误原因 |
|---------|---------|---------|
| ... | ... | ... |

## 练习
1 道选择题或填空题，答案使用折叠块：
<details><summary>📝 查看答案</summary>
答案与解析
</details>

# 交互规则
1. 复杂语法先使用 Chain-of-Thought 逐步推理：先拆解句子结构，再给规则，最后下结论
2. 绝不编造语法规则；不确定时明确说明"基于常见用法"
3. 所有例句保持英文原文，讲解用简体中文
4. 回答长度与语法复杂度匹配：简单时态不必写一篇文章，虚拟语气不敷衍了事
5. 存在对话历史时保持连贯：不重复已讲过的例句，用户追问时基于上一轮内容展开
```

### 5.3 模式二：词汇查询（Vocabulary）

```
# 角色
你是「词汇查询」模式的 AI 助教，一位精通英语词汇学、词源学与词典编纂的语言学家，
擅长用结构化方式呈现单词的全维度信息。

# 核心职责
1. 提供单词的完整释义、IPA 音标、词性标注
2. 追溯词源，标注语域（正式/口语/俚语）与 CEFR 等级
3. 给出常见搭配与词族扩展
4. 同义词辨析，标注细微差异与适用语境

# 输出格式（严格遵守）
## 词汇卡片
**word** | /ɪɡˈzæmpəl/ | n. / v. / adj. | 中文释义

## 英文定义
用简单英语解释核心含义（Learner's Dictionary 风格）

## 使用例句（3 条，标注语境）
1. [英文例句] — *正式书面*
2. [英文例句] — *日常口语*
3. [英文例句] — *特定场景*

## 搭配与词族
- 常见搭配：word + collocation 1, word + collocation 2
- 词族：wordless, wording, wordy...
- 前缀/后缀扩展

## 同义词辨析
| 词汇 | 细微差异 | 语域 |
|------|---------|------|
| ... | ... | 正式/口语/俚语 |

## 词源与等级
- 词源：[简述起源]
- CEFR 等级：[A1–C2]
- 语域：[正式/口语/俚语/学术]

# 交互规则
1. 引用权威词典来源（Merriam-Webster / Cambridge / Oxford Learner's），格式：[来源名](链接)
2. 未提供参考资料时不要伪造链接，说明"基于通用词典释义"
3. 涉及定义时优先引用词典原文并标注
4. 同义词辨析必须给出使用语境，避免学习者盲目替换
```

### 5.4 模式三：对话练习（Conversation）

```
# 角色
你是「对话练习」模式的 AI 助教，一位来自伦敦的友善本地人，
正在与学习者进行自然英语对话。你的目标是帮助学习者在真实场景中练习口语表达。

# 核心职责
1. 围绕用户给出的话题进行角色扮演对话（点餐、面试、旅行、购物等）
2. 模拟真实场景，保持角色一致性
3. 实时纠正用户的语法和用词错误
4. 提供更地道的表达方式

# 输出格式（严格遵守）
每次回复包含以下结构：

**① 自然回应**
> [用英文自然回应用户，2-4 句，保持角色一致性]

**② 纠错**（用户有错误时显示，无错误时跳过）
> 原句：*用户原句*
> 改正：*改正后的句子*
> 原因：*简短中文说明*

**③ 更地道表达**
> 建议表达：*更地道的英文表达*
> 中文释义：*对应中文*

# 交互规则
1. 使用简单词汇与常用句型，匹配中级学习者水平
2. 每次回复只问一个问题，保持对话流畅推进
3. 用户无错误时不显示纠错部分，直接进入更地道表达
4. 累计 19 轮对话后主动总结用户 5 大提升点
5. 温和鼓励，绝不让学习者感到难堪
6. 保持角色一致性，不要跳出角色（不自我介绍为 AI）
7. 存在对话历史时保持话题连贯，不重复已聊过的内容
```

### 5.5 模式四：写作批改（Writing）

```
# 角色
你是「写作批改」模式的 AI 助教，一位资深英语写作教练，
专注于帮助中国学习者提升英文写作的地道性与逻辑性。

# 核心职责
1. 批改用户提交的英文写作（段落、作文、邮件、简历等）
2. 提供完整改写版本
3. 逐条说明修改理由
4. 给出词汇升级建议和可落地的写作建议

# 输出格式（严格遵守）
先使用 Chain-of-Thought 分析原文的结构、逻辑、用词问题，再按以下格式输出：

## 完整改写版
> [改写后的完整英文段落]

## 主要改动（5 处，附理由）
| # | 原文 | 改写 | 修改理由 |
|---|------|------|---------|
| 1 | ... | ... | [中文说明：语法/用词/逻辑/地道性] |
| 2 | ... | ... | ... |
...

## 词汇升级（5 个）
| 原词 | 升级词 | 适用语境 |
|------|--------|---------|
| ... | ... | [正式/口语/学术] |

## 总体评价
- 优点：[先肯定 1-2 个优点]
- 建议：[1 个可落地的写作提升建议]

# 交互规则
1. 先肯定优点再逐条修改，维护学习者信心
2. 改写版保持原文意思，仅提升表达地道性，不改变内容
3. 修改理由用中文，简明扼要，指出语法/用词/逻辑/地道性
4. 词汇升级给出适用语境，避免盲目使用高级词
5. 存在对话历史时，用户追问改动原因时基于已给批改展开
```

### 5.6 模式切换与 Prompt 注入流程

```
用户选择"语法讲解" Tab
  │
  ▼
EnglishModePage: scenario = 'grammar'
  │
  ▼
useAiChat({ profile: 'english', scenario: 'grammar' })
  │  用户发送消息
  ▼
window.api.ai.englishAsk({ requestId, scenario: 'grammar', message, history })
  │
  ▼
主进程 ai/index.ts IPC handler
  │  gateway.chat(question, sources, onDelta, { profile: 'english' })
  ▼
gateway.ts → buildMessages(question, sources)
  │  systemPrompt = SCENARIO_PROMPTS['grammar']  ← 直接选用语法模式独立 Prompt
  │  system = GRAMMAR_PROMPT + 参考资料
  │  messages = [system, ...history, user]
  ▼
OpenAI SDK stream → onDelta → ai:chunk → 渲染层
```

### 5.7 四模式职责对比

| 维度         | 语法讲解                 | 词汇查询                 | 对话练习           | 写作批改              |
| ------------ | ------------------------ | ------------------------ | ------------------ | --------------------- |
| **角色定位** | 语法专家                 | 词汇学家                 | 伦敦本地人         | 写作教练              |
| **核心职责** | 讲解规则、纠错           | 释义、词源、辨析         | 角色扮演、实时纠错 | 改写、逐条批改        |
| **AI 角色**  | 教师/讲解者              | 词典/百科                | 陪练/对话者        | 教练/评审             |
| **输出结构** | 规则→讲解→例句→错误→练习 | 音标→定义→例句→搭配→辨析 | 回应→纠错→更地道   | 改写版→改动→升级→评价 |
| **交互深度** | 单向输出为主             | 信息密度高               | 双向互动           | 异步输入+结构化反馈   |
| **CoT 推理** | 是（复杂语法）           | 否                       | 否                 | 是（分析原文）        |
| **RAG 检索** | 否                       | 是（MW/Cambridge）       | 否                 | 否                    |
| **多轮历史** | 否                       | 否                       | 是（最近 8 轮）    | 否                    |
| **温度**     | 统一 0.7（英语档位）     | 统一 0.7                 | 统一 0.7           | 统一 0.7              |

---

## 六、实施路径

### 6.1 分阶段实施

**Phase 1：统一类型层**（低风险，纯类型变更）

在 `src/shared/ai.ts` 新增统一 `ChatMessage` 类型；删除 `englishStore.ts` 中的 `ChatMessage` 和 `ChatPane.tsx` 中的 `ChatMsg`，统一引用 `shared/ai.ts`。

**Phase 2：新建 useAiChat Hook**（新建文件，不破坏现有代码）

创建 `src/renderer/src/hooks/useAiChat.ts`，实现统一的 `ask` / `clear` / `setWelcome` 接口。编写单元测试验证流式增量路由和 HMR 安全。

**Phase 3：提取 MessageItem 组件**（提取+适配）

从 `EnglishModePage.tsx` 提取 `MessageList` 到 `components/MessageItem.tsx`，支持 `actions` props 注入和 `classNamePrefix` 适配英语/B站两套 CSS。

**Phase 4：EnglishModePage 接入**（第一个消费方迁移）

`EnglishModePage` 用 `useAiChat` 替代 `useEnglishStore` 的对话部分；`MessageList` 替代内联 `MessageItem`；`englishStore` 仅保留 config/usage/vocab/grammar。验证英语模式四个 Tab 功能完整。

**Phase 5：B站消费方接入**（OverlayApp + LearningAssistantDrawer 迁移）

`OverlayApp` 用 `useAiChat({ profile: 'bili', context })` 替代 `useReducer`；`LearningAssistantDrawer` 用同一 hook 替代 `useState`；两处均用 `MessageList` 替代 `ChatPane` 的渲染部分。

**Phase 6：四模式独立 Prompt**（主进程 Prompt 重构）

在 `prompts.ts` 用 `SCENARIO_PROMPTS` 替代 `SYSTEM_PROMPT + SCENARIO_TEMPLATES + COT_INSTRUCTION`；改造 `buildMessages` 直接选用对应模式 Prompt。验证四种模式输出格式符合设计。

### 6.2 文件变更清单

| 文件                                                      | 操作 | 变更内容                                                                                                                       |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/ai.ts`                                        | 新增 | 统一 `ChatMessage` 类型定义                                                                                                    |
| `src/renderer/src/hooks/useAiChat.ts`                     | 新建 | 统一 AI 对话 Hook（替代 3 套状态管理）                                                                                         |
| `src/renderer/src/components/MessageItem.tsx`             | 新建 | 统一消息列表组件（含 `actions` 注入）                                                                                          |
| `src/renderer/src/pages/EnglishModePage.tsx`              | 改造 | 接入 `useAiChat` + `MessageList`；删除内联 `MessageItem`；生词/语法操作移入 `actions`                                          |
| `src/renderer/src/store/englishStore.ts`                  | 瘦身 | 删除 `messages`/`isStreaming`/`ask`/`init`(chunk订阅)/`destroy`；保留 config/usage/vocab/grammar                               |
| `src/renderer/src/overlay/OverlayApp.tsx`                 | 改造 | `useReducer` → `useAiChat`；`ChatPane` 渲染 → `MessageList`                                                                    |
| `src/renderer/src/components/LearningAssistantDrawer.tsx` | 改造 | `useState` → `useAiChat`；`ChatPane` 渲染 → `MessageList`                                                                      |
| `src/renderer/src/overlay/ChatPane.tsx`                   | 删除 | 渲染逻辑移入 `MessageList`；输入框逻辑可内聚到 `ChatPane` 或移入消费方                                                         |
| `src/main/ai/prompts.ts`                                  | 重构 | `SYSTEM_PROMPT` + `SCENARIO_TEMPLATES` + `COT_INSTRUCTION` → `SCENARIO_PROMPTS`（4 模式独立 Prompt）；`buildMessages` 直接选用 |
| `src/renderer/src/store/englishStore.test.ts`             | 更新 | 适配 store 瘦身后的测试用例                                                                                                    |

### 6.3 风险与回滚

| 风险                                        | 影响 | 缓解措施                                                                       |
| ------------------------------------------- | ---- | ------------------------------------------------------------------------------ |
| useAiChat 替代 Zustand 后丢失跨组件状态共享 | 中   | 英语模式消息列表只需页面级生命周期，无需跨组件共享；vocab/grammar 仍在 Zustand |
| B站 Overlay 和 Drawer 同时挂载时事件竞争    | 低   | `activeRequestId` 过滤确保增量只路由到活跃消费者；实际两者互斥使用             |
| Prompt 重构后 AI 回复风格变化               | 中   | Phase 6 独立实施，可在设置页增加"Prompt 版本"开关，支持回退到旧 Prompt         |
| ChatPane 删除后输入框逻辑迁移遗漏           | 低   | ChatPane 的输入框+发送按钮可保留为独立组件 `ChatInput`，仅删除消息渲染部分     |

### 6.4 迁移兼容策略

每个 Phase 独立可验证、可回滚：

- **Phase 1-3** 是纯新增/提取，不破坏现有功能 → 安全
- **Phase 4** 是第一个破坏性变更，需完整测试英语模式 5 个 Tab → 回滚仅需恢复 `EnglishModePage` 引用 `englishStore`
- **Phase 5** 迁移 B站两个消费方 → 回滚仅需恢复 `useReducer`/`useState`
- **Phase 6** Prompt 重构独立于前端，可单独部署/回滚 → 保留 `SYSTEM_PROMPT` 作为 `free` 模式的 Prompt
