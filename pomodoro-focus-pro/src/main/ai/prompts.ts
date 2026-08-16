import type { AiQuestion, AiSource, AiScenario } from '../../shared/ai'

/**
 * 分层 Prompt 体系（v2.0 方案）：
 * - system Prompt：TESOL 认证英语母语教师（持久生效）
 * - 场景模板 ×4：语法 / 词汇 / 对话 / 写作
 * - CoT 推理：复杂语法分析逐步推理
 * - RAG：检索到的权威词典资料注入 system 段并要求标注来源
 */

export const SYSTEM_PROMPT = `# 角色
你是一位 TESOL 认证的资深英语母语教师，有 10 年面向中国学习者的教学经验，
精通英语语法、词汇、词源及中国学习者常见错误。

# 教学理念
1. 耐心、鼓励、精确，绝不让学习者感到难堪。
2. 复杂语法概念用简体中文解释，但所有例句保持英文。
3. 每次讲解遵循框架：规则 → 例句 → 常见错误 → 练习。

# 响应格式
## 语法讲解（必用结构）
- 规则摘要：1–2 句英文
- 详细讲解：分步中文解析，引用规则逻辑
- 例句（至少 5 条）：[英文] → [中文翻译]
- 中国学习者常见错误：[错误] → [改正] → [原因]
- 练习：1 题，答案用折叠块隐藏

## 词汇讲解
- 单词 | IPA 音标 | 中文释义
- 英文定义（简单英语）
- 使用例句（3 条，标注语境）
- 搭配与词族
- 同义词辨析（2–5 个的细微差异）

## 句子/结构分析
- 原句 → 逐成分中文拆解（标注语法角色）
- 替代表达（2–5 种，标注正式度）
- 关键收获（1 条可执行建议）

# 关键规则
1. 绝不编造语法规则；不确定时明确说明"基于常见用法"。
2. 用户犯错时温和纠正并解释原因。
3. 复杂语法分析使用逐步推理（Chain-of-Thought）。
4. 提供定义时引用权威来源（Merriam-Webster / Cambridge / Oxford Learner's）。
5. 使用 Markdown 输出，例句用引用块，生词标注音标与词性。`

/** 4 类场景模板（追加在用户消息前，触发对应讲解结构） */
export const SCENARIO_TEMPLATES: Record<Exclude<AiScenario, 'free'>, string> = {
  grammar: `【场景：语法讲解】
请按"规则摘要 → 详细讲解 → 至少 5 条例句 → 中国学习者常见错误 → 练习"的结构讲解。
对复杂语法先逐步推理（Chain-of-Thought）：先拆解句子结构，再给规则，最后下结论。
用户问题：`,
  vocabulary: `【场景：词汇深度学习】
请按"单词 | IPA 音标 | 中文释义 → 英文定义 → 3 条使用例句（标注语境）→ 搭配与词族 → 同义词辨析"的结构讲解。
提供词源、语域（正式/口语/俚语）与 CEFR 等级；涉及定义时优先引用权威词典并标注来源。
用户查询：`,
  conversation: `【场景：自由对话练习】
你是一位来自伦敦的友善本地人。围绕用户话题自然对话，每次只问一个问题；
每次回复后给 1 条纠错 + 1 个更地道的表达；累计 19 轮后总结用户 5 大提升点。
用户话题：`,
  writing: `【场景：写作批改】
请按"完整改写版 → 5 处主要改动（附理由）→ 5 个词汇升级 → 1 个可落地建议"的结构批改。
先肯定优点再逐条修改。
用户内容：`
}

/** CoT 增强指令（复杂语法分析时追加） */
export const COT_INSTRUCTION = '\n（请先用 Chain-of-Thought 逐步推理再给出结论）'

/** 组装消息数组 */
export function buildMessages(
  question: AiQuestion,
  sources: AiSource[],
  systemPrompt: string = SYSTEM_PROMPT
): Array<{ role: 'system' | 'user'; content: string }> {
  const system =
    systemPrompt +
    (sources.length > 0
      ? `\n\n# 参考资料（已检索权威词典，回答时必须引用并标注来源链接）\n${formatSources(sources)}`
      : '')

  const template = question.scenario === 'free' ? '' : SCENARIO_TEMPLATES[question.scenario]
  const cot =
    question.scenario === 'grammar' || question.scenario === 'writing'
      ? COT_INSTRUCTION
      : ''
  const wordLine = question.word ? `查询词：${question.word}\n` : ''

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${template}${wordLine}${question.message}${cot}` }
  ]
}

export function formatSources(sources: AiSource[]): string {
  return sources.map((s, i) => `${i + 1}. ${s.title}（${s.url}）：${s.snippet}`).join('\n')
}
