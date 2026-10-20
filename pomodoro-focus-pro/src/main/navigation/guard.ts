import type { WebContents } from 'electron'
import type { NavCategory, NavVerdict, BiliGuardContext } from '../../shared/bili'

/**
 * 视频学习导航管控（四层判定：L1 域名 / L2 路径 / L3 历史 / L4 内容相关性）。
 *
 * L1 域名：仅放行 bilibili.com 及其子域（www./search./api./space. 等）。
 * L2 路径：拦截 直播 / 番剧 / 影视 / 动态 四类内容；严格档额外开启 BV 白名单。
 * L3 历史：注入脚本覆写 history 计数 + 拦截 popstate（后退/侧键）。
 * L4 内容：视频页加载后提取标题/标签，与主题做关键词匹配。
 */

const BILI_HOST = 'bilibili.com'

/* ===== 同义词表（中文扩展） ===== */
const SYNONYMS: Record<string, string[]> = {
  python: ['py', 'python3'],
  javascript: ['js', 'node', 'nodejs', 'ts', 'typescript'],
  react: ['reactjs', 'nextjs', 'next.js'],
  vue: ['vuejs', 'vue3', 'nuxt', 'nuxtjs'],
  linux: ['ubuntu', 'centos', 'debian', '运维'],
  ai: ['人工智能', '机器学习', '深度学习', '神经网络', 'ml', 'dl'],
  数学: ['高数', '线代', '概率论', '微积分', '线性代数'],
  英语: ['英文', 'english', '雅思', '托福', '四级', '六级'],
  日语: ['日文', 'japanese', 'jlpt', 'n1', 'n2', 'n3'],
  编程: ['代码', 'coding', '程序设计', '开发'],
  算法: ['数据结构', 'leetcode', '刷题'],
  考研: ['研究生', '硕士'],
  高考: ['高中', '高三'],
  公考: ['公务员', '行测', '申论'],
  photoshop: ['ps', '修图', 'p图'],
  blender: ['3d', '建模', '渲染'],
  figma: ['ui', 'ux', '界面设计'],
  钢琴: ['piano', '键盘', '弹奏'],
  吉他: ['guitar', '弹唱'],
  绘画: ['素描', '水彩', '油画', '插画', '板绘']
}

/* ===== L3 历史锁定注入脚本 ===== */
const HISTORY_TRAP = `
  (() => {
    var push = history.pushState, rep = history.replaceState
    history.pushState = function (...a) { window.__navSteps = (window.__navSteps || 0) + 1; return push.apply(this, a) }
    history.replaceState = function (...a) { window.__navSteps = (window.__navSteps || 0) + 1; return rep.apply(this, a) }
    window.addEventListener('popstate', () => {
      if (location.href) history.pushState(null, '', location.href)
    })
  })()
`

/* ===== L4 内容提取脚本（C-1：多候选选择器降级链，抗 视频学习前端改版） ===== */
const CONTENT_EXTRACTOR = `
  (() => {
    function text(sel) {
      var el = document.querySelector(sel)
      return el ? (el.textContent || '').trim() : ''
    }
    var title =
      text('h1') ||                       // 视频页主标题（常见）
      text('.video-title') ||             // 老版视频标题
      text('.video-info-title') ||        // 新版视频标题容器
      text('h1.title') ||                 // 部分页面的 h1 类名变体
      (document.title || '')              // 文档标题兜底
    if (!title) {
      var og = document.querySelector('meta[property="og:title"]')
      title = og ? (og.content || '') : ''
    }
    var tags = Array.from(
      document.querySelectorAll('a[href*="tag"], a[href*="/tag/"], .tag-link, .tag-item')
    ).map(function(a) { return a.textContent || '' }).join(' ')
    return { title: title, tags: tags }
  })()
`

function deny(
  url: string,
  level: 'L1' | 'L2' | 'L3' | 'L4',
  category: NavCategory,
  reason: string,
  host = '',
  path = ''
): NavVerdict {
  return { allowed: false, level, category, reason, url, host, path }
}

/** 中文细粒度切分 + 英文按词 */
function tokenize(text: string): string[] {
  if (!text) return []
  const tokens: string[] = []
  // 英文/数字词
  const enWords = text.match(/[a-zA-Z0-9]+/g) ?? []
  tokens.push(...enWords.map((t) => t.toLowerCase()))
  // 中文：按字粒度的双字组合
  const cn = text.replace(/[a-zA-Z0-9\s]+/g, '')
  for (let i = 0; i < cn.length; i++) {
    tokens.push(cn[i])
    if (i + 1 < cn.length) tokens.push(cn[i] + cn[i + 1])
  }
  return [...new Set(tokens.filter(Boolean))]
}

/** 内容相关性判定：主题 token 命中标题/标签 */
export function isRelevantContent(title: string, tags: string, ctx: BiliGuardContext): boolean {
  const tokens = tokenize(ctx.topic)
  const hay = (title + ' ' + tags).toLowerCase()
  for (const t of tokens) {
    if (hay.includes(t.toLowerCase())) return true
    const syns = SYNONYMS[t.toLowerCase()]
    if (syns?.some((s) => hay.includes(s.toLowerCase()))) return true
  }
  return false
}

/** 严格档 BV 白名单检查 */
export function isBvAllowed(bvid: string, ctx: BiliGuardContext): boolean {
  return ctx.strictness !== 'strict' || ctx.allowedBvs.includes(bvid)
}

/**
 * 对单个 URL 做 L1 域名 + L2 路径判定（含严格档 BV 白名单）。
 * 非 http(s) 协议（data:/about:/file: 等内部页面）由调用方在 attach 时提前放行。
 */
export function isAllowedBiliUrl(rawUrl: string, ctx?: BiliGuardContext): NavVerdict {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return deny(rawUrl, 'L1', '外部', '无法解析的 URL')
  }
  const host = url.hostname.toLowerCase()
  const path = url.pathname

  // L1 域名白名单：bilibili.com 及子域
  if (host !== BILI_HOST && !host.endsWith(`.${BILI_HOST}`)) {
    return deny(rawUrl, 'L1', '外部', `域名不在白名单内: ${host}`, host, path)
  }

  // L2 路径 / 子域类别拦截
  // 直播：live.bilibili.com 或 /live 路径
  if (host.startsWith('live.') || path === '/live' || path.startsWith('/live/')) {
    return deny(rawUrl, 'L2', '直播', '直播内容已拦截（学习模式仅允许点播视频）', host, path)
  }
  // 番剧：bangumi.bilibili.com 或 /bangumi /anime /play/ss|ep
  if (
    host.startsWith('bangumi.') ||
    path.startsWith('/bangumi') ||
    path.startsWith('/anime') ||
    /^\/play\/(ss|ep)\d+/i.test(path)
  ) {
    return deny(rawUrl, 'L2', '番剧', '番剧内容已拦截', host, path)
  }
  // 影视：movie.bilibili.com 或 /movie 路径
  if (
    host.startsWith('movie.') ||
    path.startsWith('/movie') ||
    path.startsWith('/bili_channel/movie')
  ) {
    return deny(rawUrl, 'L2', '影视', '影视内容已拦截', host, path)
  }
  // 动态：t.bilibili.com 或 /opus 动态详情、用户空间动态 tab
  if (host.startsWith('t.') || path.startsWith('/opus') || path.includes('/dynamic')) {
    return deny(rawUrl, 'L2', '动态', '动态内容已拦截', host, path)
  }

  // 严格档 BV 白名单：非搜索结果 BV 不放行
  if (ctx && ctx.strictness === 'strict' && ctx.allowedBvs.length > 0) {
    const bvMatch = path.match(/\/video\/(BV[a-zA-Z0-9]+)/i)
    const bvid = bvMatch ? bvMatch[1] : ''
    if (bvid && !ctx.allowedBvs.includes(bvid)) {
      return deny(rawUrl, 'L2', '外部', '严格档：仅放行搜索结果内的视频', host, path)
    }
  }

  return { allowed: true, level: null, category: null, reason: '放行', url: rawUrl, host, path }
}

/** 生成拦截提示页 HTML（data URL 用） */
export function buildBlockPageHtml(verdict: NavVerdict): string {
  const title =
    verdict.level === 'L1'
      ? '外部站点已拦截'
      : verdict.level === 'L4'
        ? '内容不相关已拦截'
        : `「${verdict.category}」内容已拦截`
  const host = verdict.host || '(无法解析)'
  const markBtn =
    verdict.level === 'L4'
      ? `<button class="mark-btn" onclick="window.__markRelevant?.()">标记为与主题相关</button>`
      : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>导航已拦截</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0f1115; color:#e8eaed; font-family:'WorkSans','Noto Sans CJK SC',system-ui,sans-serif; }
  .card { max-width:520px; text-align:center; padding:40px; border:1px solid #2a313c; border-radius:14px; background:#171b22; }
  .badge { display:inline-block; padding:4px 12px; border-radius:999px; font-size:13px; margin-bottom:16px;
           background:rgba(255,107,74,.15); color:#ff6b4a; }
  h1 { font-size:20px; margin:0 0 10px; }
  p { font-size:13px; color:#9aa3af; line-height:1.7; margin:4px 0; word-break:break-all; }
  .url { font-family:ui-monospace,Consolas,monospace; color:#4da3ff; }
  .hint { margin-top:18px; font-size:12px; color:#9aa3af; }
  .mark-btn { margin-top:14px; padding:8px 20px; background:#ff6b4a; color:#fff; border:none; border-radius:6px;
              cursor:pointer; font-size:13px; }
  .mark-btn:hover { opacity:0.85; }
</style>
</head>
<body>
  <div class="card">
    <span class="badge">导航管控 · ${verdict.level ?? 'L?'}</span>
    <h1>${title}</h1>
    <p>原因：${verdict.reason}</p>
    <p class="url">${escapeHtml(verdict.url)}</p>
    <p class="hint">学习模式仅允许视频站点内的点播内容。<br/>请关闭本窗口，回到搜索结果页重新选择视频。</p>
    ${markBtn}
  </div>
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface GuardCallbacks {
  /** 命中拦截时回调（可在此通知渲染层 / 加载拦截页） */
  onBlocked?: (verdict: NavVerdict, webContents: WebContents) => void
  /** L4 无关内容时回调（标准档仅警告，严格档拦截） */
  onIrrelevant?: (verdict: NavVerdict, webContents: WebContents) => void
  /** L4 提取到视频标题时回调（回填当前上下文，供 AI 基于正在观看的视频作答，I-2） */
  onTitleExtracted?: (title: string) => void
}

/**
 * 为 WebContents 挂载四层导航守卫。
 * - will-navigate：主框架用户导航，拦截非法目标
 * - setWindowOpenHandler：新窗口一律拒绝，合法目标改在同窗导航
 * - did-navigate / did-navigate-in-page：SPA / 重定向落地后复查
 * - did-finish-load：注入 L3 历史陷阱 + L4 内容提取
 */
export function attachNavigationGuard(
  target: WebContents,
  ctx: BiliGuardContext,
  callbacks?: GuardCallbacks
): void {
  /** 判定单个目标 URL；非 http(s)（内部 data/about/file 页）直接放行，避免死循环 */
  const judge = (url: string): boolean => {
    if (!/^https?:/i.test(url)) return true
    const verdict = isAllowedBiliUrl(url, ctx)
    if (!verdict.allowed) {
      callbacks?.onBlocked?.(verdict, target)
      return false
    }
    return true
  }

  target.on('will-navigate', (event, url) => {
    if (!judge(url)) {
      event.preventDefault()
    }
  })

  target.setWindowOpenHandler(({ url }) => {
    if (judge(url)) {
      // 合法链接（如视频内推荐跳转）拒绝开新窗，改同窗导航保持单一受控窗口
      target.loadURL(url).catch(() => {
        /* 导航失败忽略 */
      })
    }
    return { action: 'deny' }
  })

  target.on('did-navigate', (_event, url) => {
    judge(url)
  })

  target.on('did-navigate-in-page', (_event, url) => {
    judge(url)
  })

  // L3 + L4：页面加载后注入历史陷阱 + 内容提取
  target.on('did-finish-load', async () => {
    // L3 历史锁定
    target.executeJavaScript(HISTORY_TRAP).catch(() => {
      /* CSP 阻止注入 → 降级：仅靠 will-navigate 兜底，功能不中断 */
    })

    // L4 内容相关性（宽松档跳过）
    if (ctx.strictness === 'loose') return

    /** 构造并分发 L4 无关内容判定（严格档拦截 / 标准档警告）；标题回调由调用方负责 */
    const judgeIrrelevant = (title: string, relevant: boolean): void => {
      if (relevant) return
      const verdict: NavVerdict = {
        allowed: false,
        level: 'L4',
        category: '无关内容',
        reason: `视频内容与学习主题「${ctx.topic}」不相关`,
        url: target.getURL(),
        host: new URL(target.getURL()).hostname,
        path: new URL(target.getURL()).pathname
      }
      if (ctx.strictness === 'strict') {
        callbacks?.onBlocked?.(verdict, target)
      } else {
        callbacks?.onIrrelevant?.(verdict, target)
      }
    }

    try {
      const extracted = (await target.executeJavaScript(CONTENT_EXTRACTOR)) as {
        title: string
        tags: string
      } | null
      if (!extracted) return
      if (extracted.title) callbacks?.onTitleExtracted?.(extracted.title)
      judgeIrrelevant(extracted.title, isRelevantContent(extracted.title, extracted.tags, ctx))
    } catch {
      // C-2：CSP 拦截 executeJavaScript → 降级用 document.title（webContents.getTitle
      // 不经注入即可拿到页面标题）做弱相关判定，保住标准档的 L4 兜底。
      try {
        const fallbackTitle = target.getTitle() || ''
        if (fallbackTitle) {
          callbacks?.onTitleExtracted?.(fallbackTitle)
          judgeIrrelevant(fallbackTitle, isRelevantContent(fallbackTitle, '', ctx))
        }
      } catch {
        /* 标题也拿不到 → 不误拦，仅靠 will-navigate 兜底 */
      }
    }
  })
}
