import OpenAI from 'openai'
import type { AiConfig, AiQuestion, AiReply, AiSource } from '../../shared/ai'
import { buildMessages, SCENARIO_TEMPLATES, SYSTEM_PROMPT } from './prompts'

/**
 * 英语教学网关（OpenAI 兼容 SDK）。
 * - 配置了 API Key：走真实模型流式输出
 * - 未配置（BYOK 为空）：进入演示模式，内置 TESOL 结构模拟回复，
 *   保证无 Key 时 UI/流式/来源面板全链路可验证
 */

interface MockEntry {
  scenario: AiQuestion['scenario']
  reply: (query: string, sources: AiSource[]) => string
}

const MOCK_REPLIES: MockEntry[] = [
  {
    scenario: 'grammar',
    reply: (q, sources) => [
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
      '**练习**：把 *He suggested me to study harder.* 改写为正确形式（答案：*He suggested that I study harder.*）',
      ...(sources.length ? ['', '**参考来源**：', ...sources.map((s) => `- [${s.title}](${s.url})`)] : []),
      '',
      `> 📚 演示模式（未配置 API Key）${q ? `，问题：${q}` : ''}。`
    ].join('\n')
  },
  {
    scenario: 'vocabulary',
    reply: (q, sources) => [
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
      ...(sources.length ? ['**参考来源**：', ...sources.map((s) => `- [${s.title}](${s.url})`)] : []),
      '',
      `> 📚 演示模式（未配置 API Key），查询词：${q}。`
    ].join('\n')
  },
  {
    scenario: 'conversation',
    reply: (q) => [
      "Hi there! Lovely to chat with you. 😊 Let's talk about the weather today — how's the weather where you are?",
      '',
      '**纠错**：你说 *"I am agree"* → 正确是 *"I agree"*（agree 是动词，不加 be）。',
      '',
      "**更地道表达**：*\"I couldn't agree more\"*（完全同意）",
      '',
      `> 📚 演示模式（未配置 API Key）${q ? `，话题：${q}` : ''}。`
    ].join('\n')
  },
  {
    scenario: 'writing',
    reply: (q, sources) => [
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
      ...(sources.length ? ['', '**参考来源**：', ...sources.map((s) => `- [${s.title}](${s.url})`)] : []),
      '',
      `> 📚 演示模式（未配置 API Key）${q ? `，原文：${q}` : ''}。`
    ].join('\n')
  }
]

export class EnglishGateway {
  private client: OpenAI | null = null

  constructor(private readonly getConfig: () => AiConfig) {}

  private getClient(): OpenAI | null {
    const cfg = this.getConfig()
    if (!cfg.apiKey) return null
    if (!this.client || this.client.baseURL !== cfg.baseURL) {
      this.client = new OpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined
      })
    }
    return this.client
  }

  /**
   * 流式问答：onDelta 逐段回调；resolve 时携带完整回复与 RAG 来源。
   */
  async chat(
    question: AiQuestion,
    sources: AiSource[],
    onDelta: (delta: string) => void
  ): Promise<AiReply> {
    const client = this.getClient()
    if (!client) {
      return this.mockReply(question, sources, onDelta)
    }

    const cfg = this.getConfig()
    const messages = buildMessages(question, sources)
    const stream = await client.chat.completions.create({
      model: cfg.model,
      messages,
      stream: true,
      temperature: 0.7
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
  }

  /** 演示模式：按场景输出结构化模拟回复，按词块异步流式推送 */
  private mockReply(
    question: AiQuestion,
    sources: AiSource[],
    onDelta: (delta: string) => void
  ): Promise<AiReply> {
    const entry = MOCK_REPLIES.find((m) => m.scenario === question.scenario)
    const query = question.word ?? extractQueryWord(question.message)
    const content =
      entry?.reply(query, sources) ??
      [
        '**自由问答（演示模式）**',
        '',
        `你问：「${question.message}」`,
        '',
        '配置 API Key（BYOK）后由真实模型回答。',
        ...(sources.length ? ['', '**参考来源**：', ...sources.map((s) => `- [${s.title}](${s.url})`)] : [])
      ].join('\n')

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
}

function extractQueryWord(message: string): string {
  const m = message.match(/[A-Za-z][A-Za-z'-]{2,40}/)
  return m ? m[0] : message.slice(0, 24)
}

export { SYSTEM_PROMPT, SCENARIO_TEMPLATES }
