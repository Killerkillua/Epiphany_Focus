import OpenAI from 'openai'
import type { AiConfig, AiQuestion, AiReply, AiScenario, AiSource } from '../../shared/ai'
import type { AiAskRequest } from '../../shared/bili'
import { buildBiliMessages, buildMessages, SCENARIO_TEMPLATES, SYSTEM_PROMPT } from './prompts'
import { toFriendlyAiError } from './errors'

/**
 * 英语 5 大场景超参数矩阵：
 * - 词汇查询：超低温 0.1，防释义/音标幻觉
 * - 语法讲解：低温 0.2 + CoT 逐步推理，重逻辑与句子成分拆解
 * - 写作批改：0.3 + 频率惩罚 0.2，精准润色，减少套话
 * - 自由提问：中温 0.5，平衡开放度与准确性
 * - 对话练习：0.75 + 存在惩罚 0.4，话题多变自然，避免机械重复
 */
export const SCENARIO_HYPERPARAMS: Record<
  AiScenario,
  {
    temperature: number
    top_p?: number
    presence_penalty?: number
    frequency_penalty?: number
  }
> = {
  vocabulary: { temperature: 0.1, top_p: 0.8 },
  grammar: { temperature: 0.2, top_p: 0.85, frequency_penalty: 0.1 },
  writing: { temperature: 0.3, top_p: 0.9, frequency_penalty: 0.2 },
  free: { temperature: 0.5, top_p: 0.9 },
  conversation: { temperature: 0.75, top_p: 0.95, presence_penalty: 0.4, frequency_penalty: 0.2 }
}

/**
 * AI 网关（OpenAI 兼容 SDK，双档位）：
 * - 英语教学档位（profile='english'）：TESOL 分层 Prompt + CoT + RAG，根据场景动态自适应超参数
 * - 视频学习助手档位（profile='bili'）：跨学科学习教练，注入 topic/bvid 上下文 + 多轮历史，temperature 0.5
 * - 未配置 API Key：进入演示模式，双档位各有结构化模拟回复，
 *   保证无 Key 时 UI/流式/来源面板全链路可验证
 */

/** 对话档位 */
export type AiProfile = 'english' | 'bili'

export interface ChatOptions {
  /** 档位：英语教学（默认）/ 视频学习助手 */
  profile?: AiProfile
  /** 视频学习档位时用于组装学习上下文与多轮历史 */
  biliRequest?: AiAskRequest
}

interface MockEntry {
  scenario: AiQuestion['scenario']
  reply: (query: string, sources: AiSource[]) => string
}

const MOCK_REPLIES: MockEntry[] = [
  {
    scenario: 'grammar',
    reply: (q, sources) =>
      [
        '**规则摘要**：`suggest` 后接 that 从句（虚拟语气），不接 `sb. to do`。',
        '',
        '**详细讲解**（逐步推理）：',
        '1. 拆解原句：*"I suggest him to go"* → suggest + 宾语 + to 不定式，这是中式英语常见结构。',
        '2. 规则：suggest 后应接 **that 从句（should + 动词原形）** 或 **动名词**。',
        '3. 结论：*I suggest (that) he go.*',
        '',
        '**例句**：',
        '> I suggest that he take a break.（我建议他休息一下。）',
        '> She suggested going to the library.（她建议去图书馆。）',
        '',
        '**常见错误**：`suggest sb. to do` ❌ → `suggest (that) sb. do` ✅',
        '',
        '**练习**：把 *He suggested me to study harder.* 改写为正确形式',
        '',
        '<details><summary>📝 查看答案</summary>',
        '',
        '*He suggested that I study harder.*',
        '',
        '</details>',
        ...(sources.length
          ? ['', '**参考来源**：', ...sources.map((s) => `- [${s.title}](${s.url})`)]
          : []),
        '',
        `> 📚 演示模式（未配置 API Key）${q ? `，问题：${q}` : ''}。`
      ].join('\n')
  },
  {
    scenario: 'vocabulary',
    reply: (q, sources) =>
      [
        `**${q || 'serendipity'}** | /ˌser.ənˈdɪp.ə.ti/ | 意外发现美好事物的运气`,
        '',
        '**英文定义**：the fact of finding interesting or valuable things by chance.',
        '',
        '**例句**：',
        '> Meeting her was pure serendipity.（遇见她纯属机缘巧合。）',
        '> The discovery was a happy serendipity.（这次发现是一次幸运的意外。）',
        '',
        '**搭配与词族**：serendipitous (adj.)；serendipitously (adv.)',
        '',
        '**同义词辨析**：chance（中性）/ fortune（更正式）/ coincidence（强调巧合）',
        '',
        ...(sources.length
          ? ['**参考来源**：', ...sources.map((s) => `- [${s.title}](${s.url})`)]
          : []),
        '',
        `> 📚 演示模式（未配置 API Key），查询词：${q}。`
      ].join('\n')
  },
  {
    scenario: 'conversation',
    reply: (q) =>
      [
        "Hi there! Lovely to chat with you. 😊 Let's talk about the weather today — how's the weather where you are?",
        '',
        '**纠错**：你说 *"I am agree"* → 正确是 *"I agree"*（agree 是动词，不加 be）。',
        '',
        '**更地道表达**：*"I couldn\'t agree more"*（完全同意）',
        '',
        `> 📚 演示模式（未配置 API Key）${q ? `，话题：${q}` : ''}。`
      ].join('\n')
  },
  {
    scenario: 'writing',
    reply: (q, sources) =>
      [
        '**完整改写版**：',
        '> *I believe that practicing English every day is the most effective way to improve.*',
        '',
        '**主要改动**：',
        '1. 主谓一致：`practice` → `practicing`（动名词作主语）',
        '2. 更正式表达：`very good` → `the most effective`',
        '3. 精简冗余：去掉口头语',
        '',
        '**词汇升级**：`improve` → `enhance / sharpen`',
        '',
        '**可落地建议**：每天 15 分钟影子跟读 + 每周一篇短文写作。',
        ...(sources.length
          ? ['', '**参考来源**：', ...sources.map((s) => `- [${s.title}](${s.url})`)]
          : []),
        '',
        `> 📚 演示模式（未配置 API Key）${q ? `，原文：${q}` : ''}。`
      ].join('\n')
  },
  {
    scenario: 'free',
    reply: (q, sources) =>
      [
        '**自由问答（演示回复）**',
        '',
        `你问：「${q || '（未输入内容）'}」`,
        '',
        '演示模式下，我先按通用框架回应：',
        '',
        '**要点**：',
        '1. 先明确问题的核心概念或场景',
        '2. 拆解关键要素，逐条解释',
        '3. 给出 1–2 个可直接套用的例子',
        '',
        '配置硅基流动 API Key（BYOK）后，我会针对你的具体问题给出完整、深入的解答。',
        ...(sources.length
          ? ['', '**参考来源**：', ...sources.map((s) => `- [${s.title}](${s.url})`)]
          : []),
        '',
        '> 📚 演示模式（未配置 API Key）。'
      ].join('\n')
  }
]

export class EnglishGateway {
  private client: OpenAI | null = null

  constructor(private readonly getConfig: () => AiConfig) {}

  private getClient(): OpenAI | null {
    const cfg = this.getConfig()
    if (!cfg.apiKey) return null
    if (!this.client || this.client.baseURL !== cfg.baseURL || this.client.apiKey !== cfg.apiKey) {
      this.client = new OpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined
      })
    }
    return this.client
  }

  /**
   * 流式问答：onDelta 逐段回调；resolve 时携带完整回复与 RAG 来源。
   * @param options.profile 档位（english / bili），决定提示词体系与 temperature
   * @param options.biliRequest 视频学习档位请求（学习上下文 + 多轮历史）
   */
  async chat(
    question: AiQuestion,
    sources: AiSource[],
    onDelta: (delta: string) => void,
    options: ChatOptions = {}
  ): Promise<AiReply> {
    const client = this.getClient()
    if (!client) {
      return this.mockReply(question, sources, onDelta, options)
    }

    const cfg = this.getConfig()
    const profile: AiProfile = options.profile ?? 'english'
    const messages =
      profile === 'bili' && options.biliRequest
        ? buildBiliMessages(options.biliRequest)
        : buildMessages(question, sources)

    // 根因 C 修复：create / 流式迭代 任一环节失败（401 鉴权、网络、限流等）
    // 都翻译为中文、可操作、指向「设置 → AI 设置」的错误，不再裸抛 SDK 原文。
    try {
      const scenarioParams =
        profile === 'bili'
          ? { temperature: 0.5 }
          : SCENARIO_HYPERPARAMS[question.scenario] ?? { temperature: 0.7 }

      const stream = await client.chat.completions.create({
        model: cfg.model,
        messages,
        stream: true,
        ...scenarioParams
      })

      let content = ''
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? ''
        if (delta) {
          content += delta
          onDelta(delta)
        }
      }
      return { content, sources }
    } catch (err) {
      throw toFriendlyAiError(err)
    }
  }

  /** 演示模式：按档位输出结构化模拟回复，按词块异步流式推送 */
  private mockReply(
    question: AiQuestion,
    sources: AiSource[],
    onDelta: (delta: string) => void,
    options: ChatOptions = {}
  ): Promise<AiReply> {
    const content =
      options.profile === 'bili'
        ? this.mockBiliReply(options.biliRequest)
        : this.mockEnglishReply(question, sources)

    return new Promise((resolve) => {
      const parts = content.split(/(?<=[\s。！？])/)
      let i = 0
      const timer = setInterval(() => {
        if (i < parts.length) {
          onDelta(parts[i])
          i += 1
        } else {
          clearInterval(timer)
          resolve({ content, sources })
        }
      }, 16)
    })
  }

  /** 视频学习助手演示回复：展示学习主题/视频标题、能力清单与配置入口 */
  private mockBiliReply(request?: AiAskRequest): string {
    const topic = request?.context?.topic?.trim()
    const videoTitle = request?.context?.videoTitle?.trim()
    const lines = ['**学习助手（演示模式）** 📺', '']
    if (topic) lines.push(`> 当前学习主题：「${topic}」`)
    if (videoTitle) lines.push(`> 正在观看：《${videoTitle}》`)
    if (!topic && !videoTitle) lines.push('> 当前未设置学习主题')
    lines.push(
      '',
      '我可以帮你：',
      '1. **概念讲解** —— 看不懂的点，用通俗语言讲明白',
      '2. **要点总结** —— 把视频内容归纳成结构化笔记',
      '3. **随堂测验** —— 出 1–3 道自测题检验理解',
      '4. **学习规划** —— 给出下一步 15 分钟粒度建议',
      '',
      '在「设置 → AI 设置」填写硅基流动 API Key 后，将由真实模型基于视频内容答疑。'
    )
    return lines.join('\n')
  }

  /** 英语教学演示回复：按场景输出结构化模拟回复 */
  private mockEnglishReply(question: AiQuestion, sources: AiSource[]): string {
    const entry = MOCK_REPLIES.find((m) => m.scenario === question.scenario)
    const query = question.word ?? extractQueryWord(question.message)
    return (
      entry?.reply(query, sources) ??
      [
        '**自由问答（演示模式）**',
        '',
        `你问：「${question.message}」`,
        '',
        '配置 API Key（BYOK）后由真实模型回答。',
        ...(sources.length
          ? ['', '**参考来源**：', ...sources.map((s) => `- [${s.title}](${s.url})`)]
          : [])
      ].join('\n')
    )
  }
}

function extractQueryWord(message: string): string {
  const m = message.match(/[A-Za-z][A-Za-z'-]{2,40}/)
  return m ? m[0] : message.slice(0, 24)
}

export { SYSTEM_PROMPT, SCENARIO_TEMPLATES }
