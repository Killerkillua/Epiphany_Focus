import type { AiQuestion, AiSource } from '../../shared/ai'

/**
 * RAG 检索增强：关键词触发检索权威词典。
 * 检索源：
 * - Merriam-Webster（经 dictionaryapi.dev 免费接口，数据源自 MW）
 * - Cambridge（直接抓取词典页，best-effort，可能失败则跳过）
 * - Oxford Learner's（无免费 API，命中时给出查询入口链接）
 * 全部失败时优雅降级：返回空来源，LLM 仍可回答。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const FETCH_TIMEOUT_MS = 4500

/** 从提问中提取查询词（词汇场景优先 question.word，否则取首个 ≥3 字母英文词） */
export function extractWord(question: AiQuestion): string | null {
  const fromField = question.word?.trim()
  if (fromField && /^[A-Za-z][A-Za-z' -]{1,40}$/.test(fromField)) return fromField.toLowerCase()
  const m = question.message.match(/[A-Za-z][A-Za-z'-]{2,40}/)
  return m ? m[0].toLowerCase() : null
}

interface DictEntry {
  word: string
  phonetic?: string
  meanings: string[]
}

/** Merriam-Webster 数据（dictionaryapi.dev） */
async function fetchMerriamWebster(word: string): Promise<DictEntry | null> {
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const json = (await res.json()) as Array<{
      word?: string
      phonetic?: string
      meanings?: Array<{ partOfSpeech?: string; definitions?: Array<{ definition?: string }> }>
    }>
    const first = json[0]
    if (!first) return null
    const meanings: string[] = []
    for (const m of first.meanings ?? []) {
      const def = m.definitions?.[0]?.definition
      if (def) meanings.push(`[${m.partOfSpeech ?? '?'}] ${def}`)
    }
    return { word: first.word ?? word, phonetic: first.phonetic, meanings }
  } catch {
    return null
  }
}

/** Cambridge 词典页（best-effort 抓取标题与简介，失败静默） */
async function fetchCambridge(word: string): Promise<{ title: string; snippet: string } | null> {
  try {
    const url = `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word.toLowerCase())}`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const html = await res.text()
    const titleMatch = html.match(/<title>([^<]{5,120})<\/title>/i)
    const snippetMatch = html.match(/<meta name="description" content="([^"]{20,240})"/i)
    if (!titleMatch && !snippetMatch) return null
    return {
      title: titleMatch?.[1]?.trim() ?? `Cambridge Dictionary: ${word}`,
      snippet: snippetMatch?.[1]?.trim() ?? ''
    }
  } catch {
    return null
  }
}

/** 执行 RAG 检索（并发各源，容忍失败） */
export async function runRag(question: AiQuestion): Promise<AiSource[]> {
  const word = extractWord(question)
  if (!word) return []

  const [mw, cam] = await Promise.all([fetchMerriamWebster(word), fetchCambridge(word)])

  const sources: AiSource[] = []

  if (mw) {
    const meanings = mw.meanings.slice(0, 3).join('；')
    sources.push({
      title: `Merriam-Webster: ${mw.word}${mw.phonetic ? ` /${mw.phonetic}/` : ''}`,
      url: `https://www.merriam-webster.com/dictionary/${encodeURIComponent(word)}`,
      snippet: meanings || '权威释义（音标/词性/例句）'
    })
  }

  if (cam) {
    sources.push({
      title: cam.title,
      url: `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word)}`,
      snippet: cam.snippet || 'Cambridge Dictionary 词条（释义/发音/搭配）'
    })
  }

  // Oxford Learner's：无免费 API，保留入口链接（不计入正文引用，仅提示）
  if (sources.length === 0) {
    sources.push({
      title: `Oxford Learner's Dictionaries: ${word}`,
      url: `https://www.oxfordlearnersdictionaries.com/definition/english/${encodeURIComponent(word)}`,
      snippet: '（未检索到可抓取的释义，可点击前往查询）'
    })
  }

  return sources
}
