import { describe, expect, it, vi } from 'vitest'
import {
  attachNavigationGuard,
  buildBlockPageHtml,
  isAllowedBiliUrl,
  isBvAllowed,
  isRelevantContent
} from './guard'
import type { BiliGuardContext, NavVerdict } from '../../shared/bili'
import type { WebContents } from 'electron'

/**
 * B 站导航管控测试（四层判定）。
 * - isAllowedBiliUrl：L1 域名白名单 / L2 路径类别拦截 / 严格档 BV 白名单
 * - isRelevantContent / isBvAllowed：L4 内容相关性（同义词表）与严格档白名单纯函数
 * - buildBlockPageHtml：拦截提示页（HTML 转义 / 档位文案）
 * - attachNavigationGuard：will-navigate / setWindowOpenHandler / did-finish-load（L3+L4）挂载行为
 */

function ctx(overrides: Partial<BiliGuardContext> = {}): BiliGuardContext {
  return { topic: 'python', strictness: 'standard', allowedBvs: [], ...overrides }
}

describe('isAllowedBiliUrl — L1 域名层', () => {
  it('无法解析的 URL → L1 拦截（外部）', () => {
    const v = isAllowedBiliUrl('not a url')
    expect(v.allowed).toBe(false)
    expect(v.level).toBe('L1')
    expect(v.category).toBe('外部')
    expect(v.reason).toContain('无法解析')
  })

  it('非 bilibili 域名 → L1 拦截，reason 带域名', () => {
    const v = isAllowedBiliUrl('https://example.com/watch?v=1')
    expect(v.allowed).toBe(false)
    expect(v.level).toBe('L1')
    expect(v.category).toBe('外部')
    expect(v.host).toBe('example.com')
    expect(v.path).toBe('/watch')
    expect(v.reason).toContain('example.com')
  })

  it('bilibili.com 主域与任意子域放行（www / search / api / space）', () => {
    for (const url of [
      'https://bilibili.com/',
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'https://search.bilibili.com/all?keyword=python',
      'https://api.bilibili.com/x/web-interface/search',
      'https://space.bilibili.com/123456'
    ]) {
      const v = isAllowedBiliUrl(url)
      expect(v.allowed, url).toBe(true)
      expect(v.level).toBeNull()
      expect(v.category).toBeNull()
    }
  })

  it('域名大小写归一化：大写主机名同样放行', () => {
    const v = isAllowedBiliUrl('https://WWW.BILIBILI.COM/video/BV1')
    expect(v.allowed).toBe(true)
    expect(v.host).toBe('www.bilibili.com')
  })

  it('放行判定返回原始 URL 与归一化 host/path', () => {
    const v = isAllowedBiliUrl('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(v.url).toBe('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(v.host).toBe('www.bilibili.com')
    expect(v.path).toBe('/video/BV1xx411c7mD')
  })
})

describe('isAllowedBiliUrl — L2 路径/子域类别拦截', () => {
  it('直播：live.bilibili.com 子域、/live 路径均拦截', () => {
    for (const url of [
      'https://live.bilibili.com/123',
      'https://www.bilibili.com/live',
      'https://www.bilibili.com/live/123'
    ]) {
      const v = isAllowedBiliUrl(url)
      expect(v.allowed, url).toBe(false)
      expect(v.level).toBe('L2')
      expect(v.category).toBe('直播')
    }
  })

  it('番剧：bangumi 子域、/bangumi /anime /play/ss|ep 均拦截', () => {
    for (const url of [
      'https://bangumi.bilibili.com/anime/123',
      'https://www.bilibili.com/bangumi/play/ep123',
      'https://www.bilibili.com/anime/456',
      'https://www.bilibili.com/play/ss123',
      'https://www.bilibili.com/play/ep456'
    ]) {
      const v = isAllowedBiliUrl(url)
      expect(v.allowed, url).toBe(false)
      expect(v.level).toBe('L2')
      expect(v.category).toBe('番剧')
    }
  })

  it('影视：movie 子域、/movie /bili_channel/movie 均拦截', () => {
    for (const url of [
      'https://movie.bilibili.com/123',
      'https://www.bilibili.com/movie/456',
      'https://www.bilibili.com/bili_channel/movie/789'
    ]) {
      const v = isAllowedBiliUrl(url)
      expect(v.allowed, url).toBe(false)
      expect(v.level).toBe('L2')
      expect(v.category).toBe('影视')
    }
  })

  it('动态：t.bilibili.com 子域、/opus、含 /dynamic 路径均拦截', () => {
    for (const url of [
      'https://t.bilibili.com/123',
      'https://www.bilibili.com/opus/456',
      'https://www.bilibili.com/space/123/dynamic'
    ]) {
      const v = isAllowedBiliUrl(url)
      expect(v.allowed, url).toBe(false)
      expect(v.level).toBe('L2')
      expect(v.category).toBe('动态')
    }
  })

  it('拦截判定携带 host/path 供拦截页渲染', () => {
    const v = isAllowedBiliUrl('https://live.bilibili.com/123')
    expect(v.host).toBe('live.bilibili.com')
    expect(v.path).toBe('/123')
  })
})

describe('isAllowedBiliUrl — 严格档 BV 白名单', () => {
  const strictCtx = ctx({ strictness: 'strict', allowedBvs: ['BV1', 'BV2'] })

  it('严格档：白名单内 BV 放行，白名单外 BV 拦截（L2 外部）', () => {
    const allowed = isAllowedBiliUrl('https://www.bilibili.com/video/BV1', strictCtx)
    expect(allowed.allowed).toBe(true)

    const denied = isAllowedBiliUrl('https://www.bilibili.com/video/BV999', strictCtx)
    expect(denied.allowed).toBe(false)
    expect(denied.level).toBe('L2')
    expect(denied.reason).toContain('严格档')
  })

  it('严格档白名单为空时不额外限制（搜索结果不可用时不误拦）', () => {
    const v = isAllowedBiliUrl(
      'https://www.bilibili.com/video/BV999',
      ctx({ strictness: 'strict', allowedBvs: [] })
    )
    expect(v.allowed).toBe(true)
  })

  it('标准/宽松档不受 BV 白名单限制', () => {
    for (const strictness of ['standard', 'loose'] as const) {
      const v = isAllowedBiliUrl(
        'https://www.bilibili.com/video/BV999',
        ctx({ strictness, allowedBvs: ['BV1'] })
      )
      expect(v.allowed, strictness).toBe(true)
    }
  })

  it('严格档下非视频路径（搜索页等）不受 BV 白名单限制', () => {
    const v = isAllowedBiliUrl('https://search.bilibili.com/all?keyword=react', strictCtx)
    expect(v.allowed).toBe(true)
  })
})

describe('isRelevantContent（L4 内容相关性）', () => {
  it('主题 token 直接命中标题/标签 → 相关', () => {
    expect(isRelevantContent('Python 入门教程', '', ctx({ topic: 'python' }))).toBe(true)
    expect(isRelevantContent('React Hooks 详解', 'reactjs hooks', ctx({ topic: 'react' }))).toBe(
      true
    )
  })

  it('同义词命中 → 相关（python→py、数学→高数、ai→机器学习）', () => {
    expect(isRelevantContent('Py 数据分析', '', ctx({ topic: 'python' }))).toBe(true)
    expect(isRelevantContent('高数基础', '', ctx({ topic: '数学' }))).toBe(true)
    expect(isRelevantContent('机器学习导论', '', ctx({ topic: 'ai' }))).toBe(true)
  })

  it('无关内容 → 不相关', () => {
    expect(isRelevantContent('前端切图实战', '', ctx({ topic: 'python' }))).toBe(false)
    expect(isRelevantContent('美食烹饪教程', '', ctx({ topic: '考研' }))).toBe(false)
  })

  it('空主题 → 不相关（不做误判）', () => {
    expect(isRelevantContent('Python 入门', '', ctx({ topic: '' }))).toBe(false)
  })
})

describe('isBvAllowed（严格档白名单纯函数）', () => {
  it('strict 档：仅白名单内 BV 放行', () => {
    const strict = ctx({ strictness: 'strict', allowedBvs: ['BV1'] })
    expect(isBvAllowed('BV1', strict)).toBe(true)
    expect(isBvAllowed('BV2', strict)).toBe(false)
  })

  it('standard / loose 档一律放行', () => {
    const standard = ctx({ strictness: 'standard', allowedBvs: ['BV1'] })
    const loose = ctx({ strictness: 'loose', allowedBvs: [] })
    expect(isBvAllowed('BV999', standard)).toBe(true)
    expect(isBvAllowed('BV999', loose)).toBe(true)
  })
})

describe('buildBlockPageHtml（拦截提示页）', () => {
  function denyVerdict(partial: Partial<NavVerdict>): NavVerdict {
    return {
      allowed: false,
      level: 'L1',
      category: '外部',
      reason: '域名不在白名单内',
      url: 'https://example.com',
      host: 'example.com',
      path: '/',
      ...partial
    }
  }

  it('L1 拦截页：外部站点文案 + 档位徽标', () => {
    const html = buildBlockPageHtml(denyVerdict({}))
    expect(html).toContain('外部站点已拦截')
    expect(html).toContain('导航管控 · L1')
    expect(html).toContain('域名不在白名单内')
  })

  it('L2 拦截页：显示内容类别（直播）', () => {
    const html = buildBlockPageHtml(
      denyVerdict({ level: 'L2', category: '直播', reason: '直播内容已拦截' })
    )
    expect(html).toContain('「直播」内容已拦截')
  })

  it('L4 拦截页：含"标记为相关"按钮；L1/L2 不含', () => {
    const l4 = buildBlockPageHtml(
      denyVerdict({ level: 'L4', category: '无关内容', reason: '内容不相关' })
    )
    expect(l4).toContain('内容不相关已拦截')
    // 注意：样式表恒含 `.mark-btn` CSS 选择器，故须断言按钮标记而非类名
    expect(l4).toContain('class="mark-btn"')
    expect(buildBlockPageHtml(denyVerdict({})).includes('class="mark-btn"')).toBe(false)
  })

  it('URL 做 HTML 转义（防注入）', () => {
    const html = buildBlockPageHtml(
      denyVerdict({ url: 'https://x.com/?q=<script>alert(1)</script>' })
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('attachNavigationGuard（WebContents 挂载）', () => {
  /** 构造可捕获事件处理器的假 WebContents */
  function makeWebContents() {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const wc = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers.set(event, cb)
      }),
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(),
      getURL: vi.fn(() => 'https://www.bilibili.com/video/BV1'),
      getTitle: vi.fn(() => ''),
      loadURL: vi.fn(() => Promise.resolve()),
      isDestroyed: vi.fn(() => false)
    }
    const emit = (event: string, ...args: unknown[]): void => {
      handlers.get(event)?.(...args)
    }
    return { wc, emit }
  }

  it('will-navigate：外部 URL 拦截（preventDefault + onBlocked），B 站 URL 放行', () => {
    const { wc, emit } = makeWebContents()
    const onBlocked = vi.fn()
    attachNavigationGuard(wc as unknown as WebContents, ctx(), { onBlocked })

    const evt1 = { preventDefault: vi.fn() }
    emit('will-navigate', evt1, 'https://example.com')
    expect(evt1.preventDefault).toHaveBeenCalledTimes(1)
    expect(onBlocked).toHaveBeenCalledTimes(1)
    expect(onBlocked.mock.calls[0][0].level).toBe('L1')

    const evt2 = { preventDefault: vi.fn() }
    emit('will-navigate', evt2, 'https://www.bilibili.com/video/BV1')
    expect(evt2.preventDefault).not.toHaveBeenCalled()
    expect(onBlocked).toHaveBeenCalledTimes(1)
  })

  it('非 http(s) 内部页面（about:/data:）直接放行，不触发拦截回调', () => {
    const { wc, emit } = makeWebContents()
    const onBlocked = vi.fn()
    attachNavigationGuard(wc as unknown as WebContents, ctx(), { onBlocked })
    emit('will-navigate', { preventDefault: vi.fn() }, 'about:blank')
    emit('will-navigate', { preventDefault: vi.fn() }, 'data:text/html,hi')
    expect(onBlocked).not.toHaveBeenCalled()
  })

  it('setWindowOpenHandler：一律拒绝新窗；合法 URL 改同窗导航', () => {
    const { wc } = makeWebContents()
    attachNavigationGuard(wc as unknown as WebContents, ctx())
    const handler = wc.setWindowOpenHandler.mock.calls[0][0]

    expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'https://www.bilibili.com/video/BV1' })).toEqual({ action: 'deny' })
    expect(wc.loadURL).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1')
  })

  it('did-finish-load：注入 L3 历史陷阱；标准档提取标题并回调 onTitleExtracted', async () => {
    const { wc, emit } = makeWebContents()
    wc.executeJavaScript.mockResolvedValue({ title: 'React Hooks 详解', tags: 'react' })
    const onTitle = vi.fn()
    const onBlocked = vi.fn()
    attachNavigationGuard(
      wc as unknown as WebContents,
      ctx({ topic: 'react', strictness: 'standard' }),
      {
        onTitleExtracted: onTitle,
        onBlocked
      }
    )

    emit('did-finish-load')
    await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('React Hooks 详解'))
    // L3 陷阱 + L4 提取各一次注入
    const trapCall = wc.executeJavaScript.mock.calls[0][0] as string
    expect(trapCall).toContain('history.pushState')
    // 内容相关 → 不拦截
    expect(onBlocked).not.toHaveBeenCalled()
  })

  it('严格档无关内容 → onBlocked(L4)；宽松档跳过 L4 内容判定', async () => {
    // 严格档：无关 → 拦截
    const { wc, emit } = makeWebContents()
    wc.executeJavaScript.mockResolvedValue({ title: '美食吃播合集', tags: '' })
    const onBlocked = vi.fn()
    attachNavigationGuard(
      wc as unknown as WebContents,
      ctx({ topic: 'python', strictness: 'strict' }),
      { onBlocked }
    )
    emit('did-finish-load')
    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledTimes(1))
    const verdict = onBlocked.mock.calls[0][0] as NavVerdict
    expect(verdict.level).toBe('L4')
    expect(verdict.category).toBe('无关内容')

    // 宽松档：仅注入 L3 陷阱，不做 L4 内容判定
    const { wc: wc2, emit: emit2 } = makeWebContents()
    const onBlocked2 = vi.fn()
    wc2.executeJavaScript.mockResolvedValue(undefined) // 陷阱注入正常 resolve
    attachNavigationGuard(
      wc2 as unknown as WebContents,
      ctx({ topic: 'python', strictness: 'loose' }),
      {
        onBlocked: onBlocked2
      }
    )
    emit2('did-finish-load')
    await new Promise((r) => setTimeout(r, 0))
    expect(wc2.executeJavaScript).toHaveBeenCalledTimes(1) // 只有 L3 陷阱
    expect(onBlocked2).not.toHaveBeenCalled()
  })

  it('executeJavaScript 被 CSP 拦截时降级用 document.title 做弱相关判定', async () => {
    const { wc, emit } = makeWebContents()
    wc.executeJavaScript.mockRejectedValue(new Error('CSP blocked'))
    wc.getTitle.mockReturnValue('Python 视频教程')
    const onTitle = vi.fn()
    attachNavigationGuard(
      wc as unknown as WebContents,
      ctx({ topic: 'python', strictness: 'standard' }),
      {
        onTitleExtracted: onTitle
      }
    )
    emit('did-finish-load')
    await vi.waitFor(() => expect(onTitle).toHaveBeenCalledWith('Python 视频教程'))
  })
})
