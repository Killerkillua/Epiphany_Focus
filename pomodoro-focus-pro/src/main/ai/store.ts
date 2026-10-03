import { getPublicSettings, getSettings } from '../storage/settings'
import {
  addGrammarPoint,
  addVocab as dbAddVocab,
  deleteGrammarPoint,
  deleteVocab as dbDeleteVocab,
  listGrammarPoints,
  listVocab as dbListVocab
} from '../storage/db'
import type {
  AddGrammarPayload,
  AddVocabPayload,
  AiConfig,
  AiUsage,
  GrammarPoint,
  VocabEntry
} from '../../shared/ai'

/**
 * AI 模块状态（配置走 electron-store settings.ai，生词本/语法要点走中央 SQLite）。
 * 单会话提问计数：应用运行期间有效。
 */
export class AiStore {
  private usedQuestions = 0

  getConfig(): AiConfig {
    return getSettings().ai
  }

  /** 面向渲染层的配置：API Key 仅返回掩码，不泄露明文 */
  getPublicConfig(): AiConfig {
    return getPublicSettings().ai
  }

  getUsage(): AiUsage {
    return { used: this.usedQuestions, limit: getSettings().ai.maxQuestionsPerSession }
  }

  /** 尝试占用一次提问额度；超限返回 false */
  tryUseQuestion(): boolean {
    if (this.usedQuestions >= getSettings().ai.maxQuestionsPerSession) return false
    this.usedQuestions += 1
    return true
  }

  // ================= 生词本（中央 SQLite，added_at） =================

  addVocab(payload: AddVocabPayload): VocabEntry {
    return dbAddVocab(payload)
  }

  listVocab(): VocabEntry[] {
    return dbListVocab()
  }

  deleteVocab(id: number): void {
    dbDeleteVocab(id)
  }

  // ================= 语法要点 =================

  addGrammar(payload: AddGrammarPayload): GrammarPoint {
    return addGrammarPoint(payload)
  }

  listGrammar(): GrammarPoint[] {
    return listGrammarPoints()
  }

  deleteGrammar(id: number): void {
    deleteGrammarPoint(id)
  }
}
