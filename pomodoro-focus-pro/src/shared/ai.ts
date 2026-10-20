/**
 * 英语学习模式共享类型（主进程 / preload / 渲染层共用）。
 * 仅类型定义，不引入任何运行时依赖。
 */

/** 提问场景：语法 / 词汇 / 对话 / 写作 / 自由提问 */
export type AiScenario = 'grammar' | 'vocabulary' | 'conversation' | 'writing' | 'free'

/** LLM 配置（BYOK） */
export interface AiConfig {
  /** OpenAI 兼容端点（如 https://api.siliconflow.cn/v1） */
  baseURL: string
  /** 用户自填 API Key；空 = 演示模式（内置模拟回复） */
  apiKey: string
  /** 对话模型名（如 Qwen/Qwen3.5-4B） */
  model: string
  /** 单会话提问上限 */
  maxQuestionsPerSession: number
  /** OCR 模型名（如 Qwen/Qwen3.5-4B） */
  ocrModel: string
}

/** RAG 检索到的参考来源 */
export interface AiSource {
  title: string
  url: string
  snippet: string
}

/** 多轮对话历史中的一轮（渲染层携带最近对话） */
export interface AiChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** 英语模式提问 */
export interface AiQuestion {
  /** 渲染层生成的请求关联 ID：流式 ai:chunk 事件用同一 id 关联到消息 */
  requestId: string
  scenario: AiScenario
  message: string
  /** 词汇场景的查询词（可选，自动从 message 提取） */
  word?: string
  /** 最近多轮历史（conversation/free 场景携带，主进程注入 messages 保持连贯） */
  history?: AiChatTurn[]
}

/** 流式推送块（主进程 → 渲染层，经 ai:chunk 事件） */
export interface AiStreamChunk {
  requestId: string
  /** 本次增量文本 */
  delta: string
  /** 是否流结束 */
  done: boolean
  /** done=true 时携带完整回复 */
  content?: string
  /** done=true 时携带 RAG 参考来源 */
  sources?: AiSource[]
}

/** 完整回复（invoke 返回值，英语模式）。与 视频学习 shared/bili.ts 的 BiliAiReply 命名区分。 */
export interface AiReply {
  content: string
  sources: AiSource[]
}

/** 会话用量 */
export interface AiUsage {
  used: number
  limit: number
}

/** OCR 识别请求：传入图片（dataURL 或 http(s) URL） */
export interface OcrRequest {
  /** 图片 dataURL（data:image/png;base64,...）或网络 URL */
  image: string
  /** 可选指令（如"提取正文"），OCR 模型支持文本提示 */
  prompt?: string
}

/** OCR 识别结果 */
export interface OcrResult {
  text: string
  /** 是否成功 */
  ok: boolean
  /** 失败原因（ok=false 时） */
  error?: string
}

/** 生词本条目 */
export interface VocabEntry {
  id: number
  word: string
  phonetic: string
  definition: string
  example: string
  createdAt: number
}

/** 语法要点条目 */
export interface GrammarPoint {
  id: number
  title: string
  summary: string
  createdAt: number
}

/** 加入生词本 */
export interface AddVocabPayload {
  word: string
  phonetic?: string
  definition?: string
  example?: string
}

/** 加入语法要点 */
export interface AddGrammarPayload {
  title: string
  summary: string
}
