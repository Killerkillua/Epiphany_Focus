import type { WebContents } from 'electron'
import { buildBlockPageHtml } from '../navigation/guard'
import type { NavVerdict } from '../../shared/bili'
import type { LearningSiteRule } from '../../shared/study'
import { matchSiteRule, normalizeLearningUrl } from '../../shared/study'

export interface SiteGuardCallbacks {
  onBlocked?: (verdict: NavVerdict) => void
  onTitle?: (title: string) => void
}

function blocked(url: string, reason: string): NavVerdict {
  let host = ''
  let path = ''
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    path = parsed.pathname
  } catch {
    /* 非法 URL */
  }
  return {
    allowed: false,
    level: 'L1',
    category: '外部',
    reason,
    url,
    host,
    path
  }
}

export function judgeLearningUrl(raw: string, rules: LearningSiteRule[]): NavVerdict {
  const normalized = normalizeLearningUrl(raw)
  if (!normalized.ok) return blocked(raw, normalized.reason)
  const url = normalized.url
  const rule = matchSiteRule(url, rules)
  if (!rule) {
    return blocked(url.href, `不在学习网站白名单内：${url.hostname}${url.pathname}`)
  }
  return {
    allowed: true,
    level: null,
    category: null,
    reason: '',
    url: url.href,
    host: url.hostname,
    path: url.pathname
  }
}

/**
 * 白名单网站导航守卫：每一跳（导航、重定向、页内跳转、弹窗）都重新判定。
 * 不注入站点 DOM，相关度策略只留给 B 站 Provider。
 */
export function attachSiteNavigationGuard(
  target: WebContents,
  getRules: () => LearningSiteRule[],
  callbacks?: SiteGuardCallbacks
): void {
  const judge = (url: string): boolean => {
    if (!/^https?:/i.test(url)) return false
    const verdict = judgeLearningUrl(url, getRules())
    if (!verdict.allowed) {
      callbacks?.onBlocked?.(verdict)
      return false
    }
    return true
  }

  const showBlock = (verdict: NavVerdict): void => {
    if (target.isDestroyed()) return
    target
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildBlockPageHtml(verdict))}`)
      .catch(() => {
        /* 忽略 */
      })
  }

  target.on('will-navigate', (event, url) => {
    if (!judge(url)) event.preventDefault()
  })

  target.on('will-redirect', (event, url) => {
    if (!judge(url)) event.preventDefault()
  })

  target.setWindowOpenHandler(({ url }) => {
    if (judge(url)) {
      target.loadURL(url).catch(() => {
        /* 忽略 */
      })
    } else {
      const verdict = judgeLearningUrl(url, getRules())
      if (!verdict.allowed) showBlock(verdict)
    }
    return { action: 'deny' }
  })

  target.on('did-finish-load', () => {
    const current = target.getURL()
    if (/^https?:/i.test(current) && !judge(current)) {
      showBlock(judgeLearningUrl(current, getRules()))
      return
    }
    const title = target.getTitle()
    if (title) callbacks?.onTitle?.(title)
  })
}

/** 本地播放器只允许停留在应用页面，拒绝任何外链与弹窗。 */
export function attachLocalPlayerGuard(target: WebContents): void {
  const allow = (url: string): boolean => {
    if (url.startsWith('tomato-media:')) return true
    try {
      const parsed = new URL(url)
      const dev = process.env['ELECTRON_RENDERER_URL']
      if (dev && parsed.origin === new URL(dev).origin) return true
      return parsed.protocol === 'file:'
    } catch {
      return false
    }
  }
  target.on('will-navigate', (event, url) => {
    if (!allow(url)) event.preventDefault()
  })
  target.on('will-redirect', (event, url) => {
    if (!allow(url)) event.preventDefault()
  })
  target.setWindowOpenHandler(() => ({ action: 'deny' }))
}
