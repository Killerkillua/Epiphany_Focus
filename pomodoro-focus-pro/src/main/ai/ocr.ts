import OpenAI from 'openai'
import type { AiConfig, OcrRequest, OcrResult } from '../../shared/ai'

/**
 * 图片文字识别（OCR）网关 —— 硅基流动 deepseek-ai/DeepSeek-OCR。
 *
 * DeepSeek-OCR 是多模态文档解析模型（OpenAI 兼容接口）：
 * - 输入：messages 中 content 携带 image_url（dataURL 或 http(s) URL）
 * - 输出：带布局标记（<|title|> / <|text|> / <|table|> 等）的 Markdown 结构化文本
 *
 * 配置复用 AI 设置的 baseURL / apiKey / ocrModel，随设置即时生效。
 */
export class OcrGateway {
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
   * 识别图片文字。
   * @param req.image 图片 dataURL（data:image/png;base64,...）或 http(s) URL
   * @param req.prompt 可选指令文本（如"提取全部正文，去掉页眉页脚"）
   */
  async recognize(req: OcrRequest): Promise<OcrResult> {
    const client = this.getClient()
    if (!client) {
      return {
        ok: false,
        text: '',
        error: '未配置 API Key（请到 设置 → AI 设置 填写硅基流动 API Key）'
      }
    }

    const cfg = this.getConfig()
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      {
        type: 'image_url',
        image_url: { url: req.image }
      }
    ]
    if (req.prompt?.trim()) {
      content.push({ type: 'text', text: req.prompt.trim() })
    }

    try {
      const completion = await client.chat.completions.create({
        model: cfg.ocrModel || 'deepseek-ai/DeepSeek-OCR',
        messages: [{ role: 'user', content }],
        max_tokens: 4096
      })
      const text = completion.choices[0]?.message?.content ?? ''
      if (!text.trim()) {
        return { ok: false, text: '', error: '模型未返回识别文本' }
      }
      return { ok: true, text }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, text: '', error: `OCR 调用失败：${message}` }
    }
  }
}
