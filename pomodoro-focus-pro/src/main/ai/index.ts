import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, IPC_EVENTS } from '../ipc'
import type { AiAskRequest, AiReply } from '../../shared/bili'
import type {
  AddGrammarPayload,
  AddVocabPayload,
  AiConfig,
  AiQuestion,
  AiReply as EnglishAiReply,
  AiStreamChunk,
  AiUsage,
  OcrRequest,
  OcrResult
} from '../../shared/ai'
import { EnglishGateway } from './gateway'
import { OcrGateway } from './ocr'
import { runRag } from './rag'
import { AiStore } from './store'

/**
 * AI 网关（英语教学模式核心版）。
 * - 流式问答：ai:english-ask（增量经 ai:chunk 事件推送，requestId 关联）
 * - 分层 Prompt + CoT + RAG（prompts.ts / rag.ts）
 * - BYOK 配置与 SQLite 生词本 / 语法要点（store.ts）
 * - 兼容保留 ai:ask / ai:stream（B 站悬浮助手契约）
 */
export function registerAiIpc(): void {
  const store = new AiStore()
  const gateway = new EnglishGateway(() => store.getConfig())
  const ocr = new OcrGateway(() => store.getConfig())

  // ================= B 站 overlay 兼容 =================

  ipcMain.handle(IPC_CHANNELS.ai.ask, async (_event, request: AiAskRequest): Promise<AiReply> => {
    const sources = await runRag({
      scenario: 'free',
      message: request.message,
      word: request.context?.topic?.trim() || undefined
    })
    const reply = await gateway.chat(
      { scenario: 'free', message: request.message },
      sources,
      () => undefined
    )
    return {
      role: 'assistant',
      content: reply.content,
      sources: reply.sources.map((s) => s.title)
    }
  })

  ipcMain.handle(IPC_CHANNELS.ai.stream, async (_event, request: AiAskRequest): Promise<string> => {
    const reply = await gateway.chat({ scenario: 'free', message: request.message }, [], () => undefined)
    return reply.content
  })

  // ================= 英语模式：流式问答 =================

  ipcMain.handle(
    IPC_CHANNELS.ai.englishAsk,
    async (event, question: AiQuestion): Promise<EnglishAiReply> => {
      if (!store.tryUseQuestion()) {
        throw new Error(`已达本会话提问上限（${store.getUsage().limit} 次），请重启应用或调整设置`)
      }
      const requestId = randomUUID()
      const sender = event.sender

      const sendChunk = (delta: string, done: boolean, extra?: Partial<AiStreamChunk>): void => {
        const chunk: AiStreamChunk = { requestId, delta, done, ...extra }
        if (!sender.isDestroyed()) {
          sender.send(IPC_EVENTS.ai.chunk, chunk)
        }
      }

      const sources = await runRag(question)
      const reply = await gateway.chat(question, sources, (delta) => sendChunk(delta, false))
      sendChunk('', true, { content: reply.content, sources: reply.sources })
      return reply
    }
  )

  // ================= 配置（BYOK） =================

  ipcMain.handle(IPC_CHANNELS.ai.getConfig, (): AiConfig => store.getConfig())

  ipcMain.handle(
    IPC_CHANNELS.ai.setConfig,
    (_event, patch: Partial<AiConfig>): AiConfig => store.setConfig(patch)
  )

  ipcMain.handle(IPC_CHANNELS.ai.usage, (): AiUsage => store.getUsage())

  // ================= 图片文字识别（硅基流动 DeepSeek-OCR） =================

  ipcMain.handle(
    IPC_CHANNELS.ai.ocr,
    (_event, req: OcrRequest): Promise<OcrResult> => ocr.recognize(req)
  )

  // ================= 生词本 =================

  ipcMain.handle(IPC_CHANNELS.ai.addVocab, (_event, payload: AddVocabPayload) => store.addVocab(payload))
  ipcMain.handle(IPC_CHANNELS.ai.listVocab, () => store.listVocab())
  ipcMain.handle(IPC_CHANNELS.ai.deleteVocab, (_event, id: number) => {
    store.deleteVocab(id)
    return true
  })

  // ================= 语法要点 =================

  ipcMain.handle(IPC_CHANNELS.ai.addGrammar, (_event, payload: AddGrammarPayload) =>
    store.addGrammar(payload)
  )
  ipcMain.handle(IPC_CHANNELS.ai.listGrammar, () => store.listGrammar())
  ipcMain.handle(IPC_CHANNELS.ai.deleteGrammar, (_event, id: number) => {
    store.deleteGrammar(id)
    return true
  })
}
