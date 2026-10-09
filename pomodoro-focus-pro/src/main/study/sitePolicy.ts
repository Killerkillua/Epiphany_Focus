/**
 * 学习网站策略。判定逻辑在 shared/study.ts，便于渲染层预览与单测复用。
 */
export {
  buildSiteRule,
  canonicalWebUrl,
  describeSiteRule,
  draftSiteRuleFromText,
  hostMatches,
  matchSiteRule,
  normalizeLearningUrl,
  normalizeSiteRules,
  pathAllowed,
  pathMatchesPrefix,
  sameSiteRule,
  webResourceKey
} from '../../shared/study'
