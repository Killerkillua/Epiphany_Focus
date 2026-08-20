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
import { recordTelemetry } from '../telemetry'
/**
 * AI 网关（英语教学模式 + B 站学习助手）。
 * - 流式问答：ai:english-ask（增量经 ai:chunk 事件推送，requestId 关联）
 * - 分层 Prompt + CoT + RAG（prompts.ts / rag.ts）
 * - B 站学习助手：ai:ask / ai:stream（bili 档位，注入学习上下文 topic/bvid + 多轮历史）
 * - 图片文字识别：ai:ocr（OCR 模型）
 * - BYOK 配置与 SQLite 生词本 / 语法要点（store.ts）
 */
export function registerAiIpc(): void {
  const store = new AiStore()
  const gateway = new EnglishGateway(() => store.getConfig())
  const ocr = new OcrGateway(() => store.getConfig())

  // ================= B 站学习助手（悬浮面板） =================

  ipcMain.handle(IPC_CHANNELS.ai.ask, async (_event, request: AiAskRequest): Promise<AiReply> => {
    const reply = await gateway.chat(
      { requestId: randomUUID(), scenario: 'free', message: request.message },
      [],
      () => undefined,
      { profile: 'bili', biliRequest: request }
    )
    return {
      role: 'assistant',
      content: reply.content,
      sources: reply.sources.map((s) => s.title)
    }
  })

  ipcMain.handle(IPC_CHANNELS.ai.stream, async (_event, request: AiAskRequest): Promise<string> => {
    const reply = await gateway.chat(
      { requestId: randomUUID(), scenario: 'free', message: request.message },
      [],
      () => undefined,
      { profile: 'bili', biliRequest: request }
    )
    return reply.content
  })

  // B 站档流式问答（F-4/P-2）：增量经 ai:chunk 事件推送，requestId 关联；
  // 复用 englishAsk 的流式链路，长回答逐字渲染，消除"一次性全量返回"的等待空白。
  ipcMain.handle(
    IPC_CHANNELS.ai.biliAsk,
    async (event, request: AiAskRequest): Promise<AiReply> => {
      recordTelemetry('ai', 'ask', { profile: 'bili' })
      const requestId = request.requestId || randomUUID()
      const sender = event.sender

      const sendChunk = (delta: string, done: boolean, extra?: Partial<AiStreamChunk>): void => {
        const chunk: AiStreamChunk = { requestId, delta, done, ...extra }
        if (!sender.isDestroyed()) {
          sender.send(IPC_EVENTS.ai.chunk, chunk)
        }
      }

      const reply = await gateway.chat(
        { requestId, scenario: 'free', message: request.message },
        [],
        (delta) => sendChunk(delta, false),
        { profile: 'bili', biliRequest: request }
      )
      sendChunk('', true, { content: reply.content, sources: reply.sources })
      return {
        role: 'assistant',
        content: reply.content,
        sources: reply.sources.map((s) => s.title)
      }
    }
  )

  // ================= 英语模式：流式问答 =================

  ipcMain.handle(
    IPC_CHANNELS.ai.englishAsk,
    async (event, question: AiQuestion): Promise<EnglishAiReply> => {
      if (!store.tryUseQuestion()) {
        throw new Error(`已达本会话提问上限（${store.getUsage().limit} 次），请重启应用或调整设置`)
      }
      // requestId 由渲染层生成并随问题传入，保证 ai:chunk 事件能关联到对应消息
      const requestId = question.requestId
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

  ipcMain.handle(IPC_CHANNELS.ai.usage, (): AiUsage => store.getUsage())

  // ================= 图片文字识别（OCR 模型） =================

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
