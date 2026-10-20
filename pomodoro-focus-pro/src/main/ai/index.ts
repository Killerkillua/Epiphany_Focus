import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc'
import type { AiAskRequest, BiliAiReply } from '../../shared/bili'
import type {
  AddGrammarPayload,
  AddVocabPayload,
  UpdateVocabPayload,
  AiConfig,
  AiQuestion,
  AiReply,
  AiStreamChunk,
  AiUsage,
  OcrRequest,
  OcrResult
} from '../../shared/ai'
import { EnglishGateway } from './gateway'
import { AiAbortedError, toFriendlyAiError } from './errors'
import OpenAI from 'openai'
import { OcrGateway } from './ocr'
import { runRag } from './rag'
import { AiStore } from './store'
import { recordTelemetry } from '../telemetry'
import { ValidationError, str, optStr, num, arr, oneOf } from '../validate'
/**
 * AI 网关（英语教学模式 + 视频学习助手）。
 * - 流式问答：ai:english-ask（增量经 ai:chunk 事件推送，requestId 关联）
 * - 分层 Prompt + CoT + RAG（prompts.ts / rag.ts）
 * - 视频学习助手：ai:ask / ai:stream（bili 档位，注入学习上下文 topic/bvid + 多轮历史）
 * - 图片文字识别：ai:ocr（OCR 模型）
 * - BYOK 配置与 SQLite 生词本 / 语法要点（store.ts）
 */

const AI_SCENARIOS = ['grammar', 'vocabulary', 'conversation', 'writing', 'free'] as const

/** H-01：视频学习助手请求校验（message 必填，上下文/历史可选） */
function parseBiliAskRequest(raw: unknown): AiAskRequest {
  const r = raw as AiAskRequest | null
  if (!r || typeof r !== 'object') throw new ValidationError('ai 请求必须是对象')
  const message = str(r.message, 'ai.message', { max: 20_000 })
  const requestId = optStr(r.requestId, 'ai.requestId', { max: 200 })
  let context: AiAskRequest['context']
  if (r.context !== undefined) {
    if (typeof r.context !== 'object' || r.context === null) {
      throw new ValidationError('ai.context 必须是对象')
    }
    const resourceKind = oneOf(
      r.context.resourceKind,
      'ai.context.resourceKind',
      ['bili', 'local', 'web'] as const,
      true
    )
    const rawBvid = optStr(r.context.bvid, 'ai.context.bvid', { max: 120 })
    context = {
      topic: optStr(r.context.topic, 'ai.context.topic', { max: 500 }),
      videoTitle: optStr(r.context.videoTitle, 'ai.context.videoTitle', { max: 500 }),
      resourceKind,
      // 本地路径和网站地址不进入模型上下文
      bvid: resourceKind === 'local' || resourceKind === 'web' || (rawBvid && /[\\/]/.test(rawBvid))
        ? undefined
        : rawBvid
    }
  }
  let history: AiAskRequest['history']
  if (r.history !== undefined) {
    const list = arr(r.history, 'ai.history', { max: 50 })
    history = list.map((item, i) => {
      const it = item as { role?: unknown; content?: unknown }
      const role = oneOf(it?.role, `ai.history[${i}].role`, ['user', 'assistant'] as const)
      if (!role) throw new ValidationError(`ai.history[${i}].role 必须是 user/assistant`)
      return { role, content: str(it?.content, `ai.history[${i}].content`, { max: 20_000 }) }
    })
  }
  const continueFrom = optStr(r.continueFrom, 'ai.continueFrom', { max: 40_000 })
  return { message, requestId, context, history, continueFrom }
}

/** H-01：英语模式提问校验 */
function parseEnglishQuestion(raw: unknown): AiQuestion {
  const q = raw as AiQuestion | null
  if (!q || typeof q !== 'object') throw new ValidationError('ai 提问必须是对象')
  const requestId = str(q.requestId, 'ai.question.requestId', { max: 200 })
  const scenario = oneOf(q.scenario, 'ai.question.scenario', AI_SCENARIOS)
  if (!scenario) throw new ValidationError('ai.question.scenario 非法')
  const message = str(q.message, 'ai.question.message', { max: 20_000 })
  const word = optStr(q.word, 'ai.question.word', { max: 200 })
  let history: AiQuestion['history']
  if (q.history !== undefined) {
    const list = arr(q.history, 'ai.question.history', { max: 50 })
    history = list.map((item, i) => {
      const it = item as { role?: unknown; content?: unknown }
      const role = oneOf(it?.role, `ai.question.history[${i}].role`, ['user', 'assistant'] as const)
      if (!role) throw new ValidationError(`ai.question.history[${i}].role 必须是 user/assistant`)
      return {
        role,
        content: str(it?.content, `ai.question.history[${i}].content`, { max: 20_000 })
      }
    })
  }
  const continueFrom = optStr(q.continueFrom, 'ai.question.continueFrom', { max: 40_000 })
  return { requestId, scenario, message, word, history, continueFrom }
}

function surfaceAiError(err: unknown): Error {
  if (err instanceof Error && err.name === 'Error' && !('status' in err)) return err
  return toFriendlyAiError(err)
}

const inflight = new Map<string, AbortController>()

function beginRequest(requestId: string, sender: WebContents): AbortSignal {
  for (const [id, ctrl] of inflight) {
    if (id !== requestId) ctrl.abort()
  }
  inflight.get(requestId)?.abort()
  const controller = new AbortController()
  inflight.set(requestId, controller)
  const onGone = (): void => controller.abort()
  sender.once('destroyed', onGone)
  controller.signal.addEventListener(
    'abort',
    () => {
      sender.removeListener('destroyed', onGone)
      if (inflight.get(requestId) === controller) inflight.delete(requestId)
    },
    { once: true }
  )
  return controller.signal
}

export function registerAiIpc(): void {
  const store = new AiStore()
  const gateway = new EnglishGateway(() => store.getConfig())
  const ocr = new OcrGateway(() => store.getConfig())

  // ================= 视频学习助手（悬浮面板） =================

  ipcMain.handle(
    IPC_CHANNELS.ai.ask,
    async (_event, request: AiAskRequest): Promise<BiliAiReply> => {
      const r = parseBiliAskRequest(request)
      const reply = await gateway.chat(
        { requestId: randomUUID(), scenario: 'free', message: r.message },
        [],
        () => undefined,
        { profile: 'bili', biliRequest: r }
      )
      return {
        role: 'assistant',
        content: reply.content,
        sources: reply.sources.map((s) => s.title)
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.ai.stream, async (_event, request: AiAskRequest): Promise<string> => {
    const r = parseBiliAskRequest(request)
    const reply = await gateway.chat(
      { requestId: randomUUID(), scenario: 'free', message: r.message },
      [],
      () => undefined,
      { profile: 'bili', biliRequest: r }
    )
    return reply.content
  })

  // 视频学习档流式问答（F-4/P-2）：增量经 ai:chunk 事件推送，requestId 关联；
  // 复用 englishAsk 的流式链路，长回答逐字渲染，消除"一次性全量返回"的等待空白。
  ipcMain.handle(
    IPC_CHANNELS.ai.biliAsk,
    async (event, request: AiAskRequest): Promise<BiliAiReply> => {
      recordTelemetry('ai', 'ask', { profile: 'bili' })
      const r = parseBiliAskRequest(request)
      const requestId = r.requestId || randomUUID()
      const sender = event.sender

      const sendChunk = (delta: string, done: boolean, extra?: Partial<AiStreamChunk>): void => {
        const chunk: AiStreamChunk = { requestId, delta, done, ...extra }
        if (!sender.isDestroyed()) {
          sender.send(IPC_EVENTS.ai.chunk, chunk)
        }
      }

      const signal = beginRequest(requestId, sender)
      try {
        const reply = await gateway.chat(
          { requestId, scenario: 'free', message: r.message },
          [],
          (delta) => sendChunk(delta, false),
          { profile: 'bili', biliRequest: r, signal, continueFrom: r.continueFrom }
        )
        sendChunk('', true, { content: reply.content, sources: reply.sources })
        return {
          role: 'assistant',
          content: reply.content,
          sources: reply.sources.map((s) => s.title)
        }
      } catch (err) {
        if (err instanceof AiAbortedError) {
          sendChunk('', true, { aborted: true })
          return { role: 'assistant', content: r.continueFrom ?? '', sources: [] }
        }
        const friendly = surfaceAiError(err)
        sendChunk('', true, { incomplete: true, error: friendly.message })
        throw friendly
      }
    }
  )

  // ================= 英语模式：流式问答 =================

  ipcMain.handle(
    IPC_CHANNELS.ai.englishAsk,
    async (event, question: AiQuestion): Promise<AiReply> => {
      const q = parseEnglishQuestion(question)
      if (!q.continueFrom && !store.tryUseQuestion()) {
        throw new Error(`已达本会话提问上限（${store.getUsage().limit} 次），请重启应用或调整设置`)
      }
      const requestId = q.requestId
      const sender = event.sender

      const sendChunk = (delta: string, done: boolean, extra?: Partial<AiStreamChunk>): void => {
        const chunk: AiStreamChunk = { requestId, delta, done, ...extra }
        if (!sender.isDestroyed()) {
          sender.send(IPC_EVENTS.ai.chunk, chunk)
        }
      }

      const signal = beginRequest(requestId, sender)
      try {
        const sources = await runRag(q)
        const reply = await gateway.chat(q, sources, (delta) => sendChunk(delta, false), {
          signal,
          continueFrom: q.continueFrom
        })
        sendChunk('', true, { content: reply.content, sources: reply.sources })
        return reply
      } catch (err) {
        if (err instanceof AiAbortedError) {
          sendChunk('', true, { aborted: true })
          return { content: q.continueFrom ?? '', sources: [] }
        }
        const friendly = surfaceAiError(err)
        sendChunk('', true, { incomplete: true, error: friendly.message })
        throw friendly
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.ai.abort, (_event, requestId: unknown): void => {
    const id = str(requestId, 'ai.abort.requestId', { max: 200 })
    inflight.get(id)?.abort()
  })

  ipcMain.handle(IPC_CHANNELS.ai.ping, async (): Promise<{ ok: boolean; message: string }> => {
    const cfg = store.getConfig()
    if (!cfg.apiKey) return { ok: false, message: '请先填写并保存 API Key' }
    try {
      const client = new OpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined,
        timeout: 15_000,
        maxRetries: 0
      })
      await client.chat.completions.create({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      })
      return { ok: true, message: '连接成功' }
    } catch (err) {
      return { ok: false, message: toFriendlyAiError(err).message }
    }
  })

  // ================= 配置（BYOK） =================

  ipcMain.handle(IPC_CHANNELS.ai.getConfig, (): AiConfig => store.getPublicConfig())

  ipcMain.handle(IPC_CHANNELS.ai.usage, (): AiUsage => store.getUsage())

  // ================= 图片文字识别（OCR 模型） =================

  ipcMain.handle(IPC_CHANNELS.ai.ocr, (_event, req: OcrRequest): Promise<OcrResult> => {
    if (!req || typeof req !== 'object') throw new ValidationError('ocr 请求必须是对象')
    const image = str(req.image, 'ocr.image', { max: 20_000_000 })
    const prompt = optStr(req.prompt, 'ocr.prompt', { max: 2000 })
    return ocr.recognize({ image, prompt })
  })

  // ================= 生词本 =================

  ipcMain.handle(IPC_CHANNELS.ai.addVocab, (_event, payload: AddVocabPayload) => {
    if (!payload || typeof payload !== 'object') throw new ValidationError('生词本写入必须是对象')
    const p = payload as AddVocabPayload
    const word = str(p.word, 'vocab.word', { max: 200 }).trim()
    if (!word) throw new ValidationError('vocab.word 不能为空')
    return store.addVocab({
      word,
      phonetic: optStr(p.phonetic, 'vocab.phonetic', { max: 200 }),
      definition: optStr(p.definition, 'vocab.definition', { max: 2000 }),
      example: optStr(p.example, 'vocab.example', { max: 2000 })
    })
  })
  ipcMain.handle(IPC_CHANNELS.ai.listVocab, () => store.listVocab())
  ipcMain.handle(IPC_CHANNELS.ai.updateVocab, (_event, payload: UpdateVocabPayload) => {
    if (!payload || typeof payload !== 'object') throw new ValidationError('生词释义更新必须是对象')
    const p = payload as UpdateVocabPayload
    const id = num(p.id, 'vocab.id')
    const definition = str(p.definition, 'vocab.definition', { max: 2000, allowEmpty: true }).trim()
    const entry = store.updateVocab(id, definition)
    if (!entry) throw new ValidationError('生词不存在')
    return entry
  })
  ipcMain.handle(IPC_CHANNELS.ai.deleteVocab, (_event, id: number) => {
    store.deleteVocab(num(id, 'vocab.id'))
    return true
  })

  // ================= 语法要点 =================

  ipcMain.handle(IPC_CHANNELS.ai.addGrammar, (_event, payload: AddGrammarPayload) => {
    if (!payload || typeof payload !== 'object') throw new ValidationError('语法要点写入必须是对象')
    const p = payload as AddGrammarPayload
    return store.addGrammar({
      title: str(p.title, 'grammar.title', { max: 500 }),
      summary: str(p.summary, 'grammar.summary', { max: 5000 })
    })
  })
  ipcMain.handle(IPC_CHANNELS.ai.listGrammar, () => store.listGrammar())
  ipcMain.handle(IPC_CHANNELS.ai.deleteGrammar, (_event, id: number) => {
    store.deleteGrammar(num(id, 'grammar.id'))
    return true
  })
}
