import { describe, expect, it } from 'vitest'
import {
  buildSiteRule,
  draftSiteRuleFromText,
  firstBlockedHop,
  hostMatches,
  matchSiteRule,
  normalizeLearningUrl,
  normalizeSiteRules,
  pathMatchesPrefix
} from './study'

describe('学习网站白名单', () => {
  const github = buildSiteRule({ host: 'github.com' }).rule!

  it('规范化 https，拒绝凭据、非网页协议和非默认端口', () => {
    expect(normalizeLearningUrl('https://leetcode.cn/problems').ok).toBe(true)
    expect(normalizeLearningUrl('http://127.0.0.1:80/lab').ok).toBe(true)
    expect(normalizeLearningUrl('http://evil.example').ok).toBe(false)
    expect(normalizeLearningUrl('javascript:alert(1)').ok).toBe(false)
    expect(normalizeLearningUrl('https://user:pass@github.com').ok).toBe(false)
    expect(normalizeLearningUrl('https://github.com:8443/repo').ok).toBe(false)
  })

  it('子域按点边界匹配，不误放行后缀域名', () => {
    expect(hostMatches('github.com', github)).toBe(true)
    expect(hostMatches('gist.github.com', github)).toBe(true)
    expect(hostMatches('evilgithub.com', github)).toBe(false)
    expect(hostMatches('github.com.evil.test', github)).toBe(false)
  })

  it('路径前缀只匹配目录边界', () => {
    expect(pathMatchesPrefix('/problems/two-sum', '/problems')).toBe(true)
    expect(pathMatchesPrefix('/problems', '/problems')).toBe(true)
    expect(pathMatchesPrefix('/problems-extra', '/problems')).toBe(false)
  })

  it('完整网址草稿带上路径前缀', () => {
    const draft = draftSiteRuleFromText('https://leetcode.cn/problems')
    expect(draft.ok).toBe(true)
    expect(draft.rule?.host).toBe('leetcode.cn')
    expect(draft.rule?.pathPrefixes).toEqual(['/problems'])
    expect(draft.summary).toContain('/problems')
  })

  it('重定向链在越界的那一跳被拒绝', () => {
    const rules = [github]
    expect(
      firstBlockedHop(
        ['https://github.com/org/repo', 'https://gist.github.com/a', 'https://evil.example/phish'],
        rules
      )
    ).toBe('https://evil.example/phish')
    expect(firstBlockedHop(['https://github.com/a', 'https://www.github.com/b'], rules)).toBeNull()
    expect(matchSiteRule(new URL('https://www.github.com/b'), rules)?.host).toBe('github.com')
  })

  it('规则列表拒绝重复项', () => {
    expect(() =>
      normalizeSiteRules([
        { host: 'github.com', includeSubdomains: true, pathPrefixes: [], enabled: true, label: 'a' },
        { host: 'github.com', includeSubdomains: true, pathPrefixes: [], enabled: true, label: 'b' }
      ])
    ).toThrow(/重复/)
  })
})
