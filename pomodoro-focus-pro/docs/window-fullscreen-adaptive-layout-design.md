# 窗口模式与全屏模式布局自适应设计方案

> **项目**: 番茄专注 Pro (Electron 33 + React 18 + antd 5.24)  
> **日期**: 2026 年 8 月 18 日  
> **版本**: 1.0  
> **状态**: DRAFT — 待确认  
> **范围**: 全部 7 个页面，全部核心原则，仅设计不修改代码

---

## 目录

1. [背景与问题分析](#1-背景与问题分析)
2. [现有代码基线](#2-现有代码基线)
3. [核心设计原则](#3-核心设计原则)
4. [自适应策略架构（三层）](#4-自适应策略架构三层)
5. [视口断点策略](#5-视口断点策略)
6. [实施方案 — 阶段一：基础层](#6-实施方案--阶段一基础层)
7. [实施方案 — 阶段二：核心布局适配](#7-实施方案--阶段二核心布局适配)
8. [实施方案 — 阶段三：Container Queries 与精细化增强](#8-实施方案--阶段三container-queries-与精细化增强)
9. [组件级适配方案（逐页）](#9-组件级适配方案逐页)
10. [技术实现蓝图](#10-技术实现蓝图)
11. [实施路线图](#11-实施路线图)
12. [验证策略](#12-验证策略)
13. [边界条件与风险](#13-边界条件与风险)
14. [验收标准](#14-验收标准)
15. [术语表](#15-术语表)
16. [架构决策记录](#16-架构决策记录)

---

## 1. 背景与问题分析

### 1.1 两种模式的本质差异

窗口模式与全屏模式之间的布局不一致，**根因在于视口尺寸的剧烈变化**，而非简单的"放大缩小"。

| 维度          | 窗口模式            | 全屏模式              |
| ------------- | ------------------- | --------------------- |
| 视口宽度      | 通常 800px – 1600px | 通常 1920px – 2560px+ |
| 浏览器 Chrome | 占用空间            | 消失，额外垂直空间    |
| 尺寸调整      | 用户可随时拖拽      | 固定（显示器分辨率）  |
| 并列显示      | 常有其他窗口并列    | 独占全屏              |
| 用户预期      | 对"紧凑感"有预期    | 对"空间感"有预期      |

### 1.2 现有代码中的具体表现

| 问题类型     | 窗口模式表现               | 全屏模式表现                   | 影响程度 |
| ------------ | -------------------------- | ------------------------------ | -------- |
| 内容区域宽度 | 内容充满可用空间，布局紧凑 | 内容过度拉伸，文本行过长       | 高       |
| 网格列数     | 卡片大小适中               | 列数未增加，卡片巨大或间距过大 | 高       |
| 导航栏       | Sider 220px 正常           | Sider 220px 在超宽屏下比例失调 | 中       |
| 间距系统     | 固定 px 间距，视觉节奏正常 | 间距保持不变，大屏下显得空旷   | 中       |
| 字体大小     | 固定字号，可读性正常       | 字号未随视口缩放，大屏偏小     | 中       |
| 侧栏宽度     | 320px/300px 合理           | 固定值在超宽屏下比例失调       | 中       |

### 1.3 根本原因

1. **固定像素思维**：使用固定 `px` 值定义宽度、间距、字号，缺乏随视口变化的弹性机制。
2. **缺乏内容宽度上限**：没有设置 `max-width`，内容在超宽屏幕上无限拉伸。
3. **视口断点缺失**：项目没有任何 `@media` 媒体查询和 `@container` 容器查询。

> **核心认知**：窗口 ↔ 全屏不是"大屏 vs 小屏"的问题，而是**同一设备上连续视口谱系的两端**。设计应从"模式切换"思维转向"连续自适应"思维。

---

## 2. 现有代码基线

### 2.1 技术栈

| 层级      | 技术                              | 版本   |
| --------- | --------------------------------- | ------ |
| 运行时    | Electron                          | 33     |
| 框架      | React                             | 18     |
| 语言      | TypeScript                        | 5.7    |
| 构建      | electron-vite (Vite 6)            | 3.1.0  |
| UI 组件库 | Ant Design (antd, dark algorithm) | 5.24.2 |
| 状态管理  | Zustand                           | 5.0.3  |
| 图表      | Recharts                          | 2.15.4 |
| 测试      | Vitest                            | 4.1.10 |

### 2.2 样式架构

- **单文件 global.css**（1395 行，23943 字节）——全项目唯一样式文件
- 无 CSS Modules / CSS-in-JS / Tailwind / SCSS
- `:root` 中仅有颜色和字体 CSS 变量，**无间距/字号/尺寸 token**
- antd ConfigProvider 仅配置颜色 token，未覆盖断点

### 2.3 当前布局范式

```
App.tsx
├── <Sider width={220}>     ← 固定 220px，无折叠
│   ├── .app-logo (64px height)
│   └── <Menu> (7 项导航)
└── <Content className="app-content">
    └── <ScrollArea>       ← padding: 28px 32px，无 max-width
        └── 各页面组件
```

### 2.4 现有自适应能力（极度有限）

| 技术                  | 使用情况                | 位置                                                                           |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `@media` 媒体查询     | **零**                  | —                                                                              |
| `@container` 容器查询 | **零**                  | —                                                                              |
| `clamp()`             | **仅 1 处**             | `.focus-timer { font-size: clamp(72px, 12vw, 120px) }` (L350)                  |
| `max-width`           | **仅 3 处**（局部约束） | `.chat-msg-bubble` (L552), `.bili-search-input` (L768), `.overlay-msg` (L1088) |
| Grid `auto-fill`      | 3 处                    | `.bili-grid` (L803), `.mode-grid` (L1330), `.settings-layout` (L1227)          |
| `calc()`              | 1 处                    | `.english-layout { height: calc(100vh - 200px) }` (L517)                       |
| antd 断点覆盖         | **无**                  | main.tsx ConfigProvider 未配置                                                 |

### 2.5 多窗口架构

| 窗口         | 尺寸             | 最小尺寸 | 可全屏 | 可调整大小     |
| ------------ | ---------------- | -------- | ------ | -------------- |
| 主窗口       | 1200×800         | 940×640  | —      | 是             |
| 学习视频窗口 | 1280×760         | 900×560  | 是     | 是             |
| 悬浮面板     | 340×560 / 64×240 | —        | —      | **否（固定）** |

> 实际视口宽度范围：主窗口 940px–2560px+，视频学习窗口 900px–全屏。悬浮面板固定尺寸，排除出自适应范围。

---

## 3. 核心设计原则

### 3.1 流体优先，容器驱动

> 组件不应关心自己在哪个视口下，而应关心自己所在容器的实际可用空间。

采用 Container Queries 让组件根据自身容器的宽度自适应。同一组件放在窄侧边栏和宽主内容区时自动呈现不同的布局形态。

### 3.2 连续谱系而非离散模式

> 窗口和全屏不是两个孤立的"模式"，而是从 800px 到 2560px+ 的连续视口谱系。

使用 `clamp()`、`min()`、`max()` 等 CSS 数学函数实现无级缩放，而非在几个固定断点之间跳跃。例如：`font-size: clamp(1rem, 0.8rem + 1vw, 1.5rem)` 让字体在窗口和全屏之间平滑过渡。

### 3.3 内容决定断点

> 不以设备尺寸定义断点，而在内容实际"撑不住"的地方设置断点。

逐步缩小视口，观察内容何时溢出、文本行何时过长、网格何时过于稀疏，在这些临界点设置断点。

### 3.4 上限约束原则

> 任何内容区域都应有合理的最大宽度。

在主内容区设置 `max-width`（阅读型 1200px，数据型 1600px），在超宽显示器上内容居中显示，两侧留白。

---

## 4. 自适应策略架构（三层）

```
┌─────────────────────────────────────────────────────┐
│ 第一层：页面级布局（视口媒体查询 @media）              │
│   页面整体结构切换：单栏 → 双栏 → 多栏                 │
├─────────────────────────────────────────────────────┤
│ 第二层：区域级布局（容器查询 @container）              │
│   组件内部布局调整：卡片横排 → 竖排                    │
├─────────────────────────────────────────────────────┤
│ 第三层：元素级缩放（CSS 数学函数 clamp/min/max）       │
│   字号、间距、尺寸无级连续缩放                         │
└─────────────────────────────────────────────────────┘
```

| 层级   | 技术                          | 职责             | 改动位置                   |
| ------ | ----------------------------- | ---------------- | -------------------------- |
| 页面级 | `@media (min-width: ...)`     | 整体布局结构切换 | global.css                 |
| 区域级 | `@container (min-width: ...)` | 组件内部布局调整 | global.css + 页面容器      |
| 元素级 | `clamp()` / `min()` / `max()` | 字号、间距、尺寸 | global.css + `:root` token |

---

## 5. 视口断点策略

采用**内容驱动**的断点体系，而非传统的设备尺寸断点：

| 断点名称  | 视口宽度        | 典型场景         | 布局策略                           | 对本项目的实际触发                         |
| --------- | --------------- | ---------------- | ---------------------------------- | ------------------------------------------ |
| Compact   | < 768px         | 小窗口、平板竖屏 | 单栏布局，导航折叠                 | 主窗口 min 940，**实际不触发**；保留供未来 |
| Medium    | 768px – 1200px  | 标准窗口模式     | 双栏布局，侧栏可折叠，网格 2–3 列  | 主窗口 940px 时触发                        |
| Wide      | 1200px – 1600px | 大窗口/小屏全屏  | 多栏布局，侧栏常驻，max-width 生效 | 主窗口默认 1200px 及以上                   |
| Ultrawide | > 1600px        | 全屏/超宽显示器  | 内容 max-width 居中，侧栏封顶      | 全屏模式 (1920px+)                         |

---

## 6. 实施方案 — 阶段一：基础层

> **目标**：建立流体排版尺度、内容区域 max-width 约束、CSS 自定义属性管理间距。  
> **改动范围**：global.css `:root` + 全局排版规则。  
> **风险**：低 — 改动集中在 CSS 变量和全局样式。

### 6.1 CSS 自定义属性（Design Tokens）

在 global.css 的 `:root` 中新增设计 token 系统：

```css
:root {
  /* ===== 现有颜色/字体 token 保持不变 ===== */

  /* ===== 间距尺度（流体） ===== */
  --space-xs: clamp(0.25rem, 0.2rem + 0.15vw, 0.375rem); /*  4px –  6px */
  --space-sm: clamp(0.5rem, 0.45rem + 0.25vw, 0.75rem); /*  8px – 12px */
  --space-md: clamp(0.75rem, 0.65rem + 0.5vw, 1.25rem); /* 12px – 20px */
  --space-lg: clamp(1rem, 0.8rem + 1vw, 1.75rem); /* 16px – 28px */
  --space-xl: clamp(1.5rem, 1.1rem + 2vw, 2.5rem); /* 24px – 40px */
  --space-2xl: clamp(2rem, 1.5rem + 3vw, 3.5rem); /* 32px – 56px */

  /* ===== 字号尺度（流体） ===== */
  --text-xs: clamp(0.75rem, 0.72rem + 0.15vw, 0.875rem); /* 12px – 14px */
  --text-sm: clamp(0.85rem, 0.82rem + 0.15vw, 0.95rem); /* ~14px – 15px */
  --text-base: clamp(0.95rem, 0.9rem + 0.3vw, 1.1rem); /* ~15px – 18px */
  --text-lg: clamp(1.1rem, 1rem + 0.4vw, 1.35rem); /* ~18px – 22px */
  --text-xl: clamp(1.4rem, 1rem + 1.8vw, 2.2rem); /* ~22px – 35px */
  --text-2xl: clamp(1.75rem, 1.2rem + 2.5vw, 3rem); /* ~28px – 48px */

  /* ===== 内容宽度上限 ===== */
  --content-max: 1200px; /* 阅读型内容上限 */
  --dashboard-max: 1600px; /* 数据密集型上限 */

  /* ===== 断点引用 ===== */
  --bp-compact: 768px;
  --bp-medium: 1200px;
  --bp-wide: 1600px;
}
```

### 6.2 流体排版 — 替换固定字号

| 当前规则             | 行号  | 当前值                     | 目标值                                   |
| -------------------- | ----- | -------------------------- | ---------------------------------------- |
| `.page-title`        | L222  | `font-size: 20px`          | `font-size: var(--text-lg)`              |
| `.app-logo-text`     | L189  | `font-size: 15px`          | `font-size: var(--text-sm)`              |
| `.app-logo-mark`     | L184  | `font-size: 20px`          | `font-size: var(--text-lg)`              |
| `.focus-timer`       | L350  | `clamp(72px, 12vw, 120px)` | 对齐到 `--text-2xl` 尺度或保留独立 clamp |
| `.mode-card` 标题    | —     | 固定值                     | `font-size: var(--text-lg)`              |
| `.bili-card` 标题    | —     | 固定值                     | `font-size: var(--text-sm)`              |
| `.stats-card` 标题   | —     | 固定值                     | `font-size: var(--text-lg)`              |
| `.field-label`       | L420  | `font-size: 12px`          | `font-size: var(--text-xs)`              |
| `.session-bar-title` | L448  | `font-size: 14px`          | `font-size: var(--text-sm)`              |
| `.vocab-def`         | L740  | `font-size: 12px`          | `font-size: var(--text-xs)`              |
| `.grammar-summary`   | L746  | `font-size: 12.5px`        | `font-size: var(--text-xs)`              |
| `.heatmap-wd`        | L1316 | `font-size: 11px`          | `font-size: var(--text-xs)`              |

### 6.3 内容区域 max-width 约束

| 规则           | 行号 | 当前值               | 目标值                                                                                |
| -------------- | ---- | -------------------- | ------------------------------------------------------------------------------------- |
| `.app-content` | L215 | `padding: 28px 32px` | `max-width: var(--content-max); margin-inline: auto; padding: clamp(1rem, 3vw, 3rem)` |
| 统计页容器     | —    | 无 max-width         | `max-width: var(--dashboard-max); margin-inline: auto`                                |
| 视频学习页容器     | —    | 无 max-width         | `max-width: var(--dashboard-max); margin-inline: auto`                                |

### 6.4 流体间距 — 替换固定 gap/margin/padding

| 规则                     | 行号  | 当前值      | 目标值                            |
| ------------------------ | ----- | ----------- | --------------------------------- |
| `.app-content` padding   | L215  | `28px 32px` | `var(--space-lg) var(--space-xl)` |
| `.mode-grid` gap         | L1331 | `16px`      | `var(--space-md)`                 |
| `.bili-grid` gap         | L805  | `16px`      | `var(--space-md)`                 |
| `.settings-layout` gap   | L1228 | `14px`      | `var(--space-sm)`                 |
| `.focus-side` gap        | L412  | `16px`      | `var(--space-md)`                 |
| `.english-layout` gap    | L516  | `16px`      | `var(--space-md)`                 |
| `.focus-controls` gap    | L403  | `12px`      | `var(--space-sm)`                 |
| `.session-bar-inner` gap | L439  | `20px`      | `var(--space-md)`                 |

---

## 7. 实施方案 — 阶段二：核心布局适配

> **目标**：Sider 自适应、页面级布局切换、固定侧栏 → 流体宽度、网格增强。  
> **改动范围**：App.tsx + global.css + 各页面组件。  
> **风险**：中 — 涉及核心组件，需回归测试。

### 7.1 自适应 Sider（导航栏）

**App.tsx 改动**：

```tsx
// 当前
<Sider width={220} className="app-sider">

// 目标
<Sider
  collapsible
  collapsedWidth={56}
  width={240}
  breakpoint="md"
  onBreakpoint={(broken) => setSiderCollapsed(broken)}
  className="app-sider"
>
```

**global.css 改动**：

```css
.app-sider {
  background: var(--bg2) !important;
  border-right: 1px solid var(--rule);
  /* 全屏下侧栏宽度上限，防止无限拉伸 */
  max-width: 280px;
}
```

**断点行为**：

| 视口范围             | Sider 形态         | 宽度策略               |
| -------------------- | ------------------ | ---------------------- |
| Compact (< 768px)    | 折叠为图标栏       | 56px                   |
| Medium (768–1200px)  | 折叠为图标模式     | 56px (collapsedWidth)  |
| Wide (1200–1600px)   | 常驻展开           | 240px                  |
| Ultrawide (> 1600px) | 常驻展开，不再增大 | 280px (max-width 封顶) |

### 7.2 页面级布局切换（@media）

在 global.css 中引入 3 个内容驱动断点：

```css
/* ===== 默认（窄于 Medium）：堆叠布局 ===== */
.focus-layout,
.english-layout {
  flex-direction: column;
}
.focus-side,
.english-side {
  width: 100%;
}

/* ===== Medium: 标准窗口模式 — 双栏布局激活 ===== */
@media (min-width: 768px) {
  .focus-layout,
  .english-layout {
    flex-direction: row;
  }
}

/* ===== Wide: 大窗口/小屏全屏 — max-width 生效；数据型页面放宽 ===== */
@media (min-width: 1200px) {
  .app-content {
    max-width: var(--content-max);
    margin-inline: auto;
  }
  /* 数据密集型页面（统计 / 视频学习，.page-dashboard）在宽容器下放宽到 --dashboard-max，
     不再被 .app-content 的 1200px 上限卡住；阅读型页面保持 --content-max */
  .app-content:has(.page-dashboard) {
    max-width: var(--dashboard-max);
  }
}

/* ===== Ultrawide: 全屏/超宽 — 侧栏封顶，数据区保持上限 ===== */
@media (min-width: 1600px) {
  .app-sider {
    width: 280px !important;
  }
  .app-content:has(.page-dashboard) {
    max-width: var(--dashboard-max);
  }
}
```

> **实现对齐（P-2）**：数据型页面（统计 / 视频学习）的 1600px 上限在 **Wide（≥1200px）** 即生效——
> 视口 1200–1600px 时可随视口增长（上限 1600px），Ultrawide 下保持 1600px 居中；
> 阅读型页面（首页/专注/英语/记事本/设置）始终为 `--content-max`（1200px）。
> 与 §3.4「阅读型 1200px，数据型 1600px」及 ADR 0001 口径一致。

> **注意**：主窗口 minWidth 940px 意味着默认的堆叠布局（< 768px）实际不触发，但保留供 视频学习窗口和未来兼容。

### 7.3 固定侧栏 → 流体宽度

| 规则            | 行号 | 当前值                         | 目标值                                             |
| --------------- | ---- | ------------------------------ | -------------------------------------------------- |
| `.focus-side`   | L408 | `width: 320px; flex-shrink: 0` | `width: clamp(240px, 22vw, 340px); flex-shrink: 0` |
| `.english-side` | L725 | `width: 300px; flex-shrink: 0` | `width: clamp(220px, 20vw, 320px); flex-shrink: 0` |
| `.ai-settings`  | L752 | `width: 280px`                 | `width: clamp(200px, 18vw, 300px)`                 |

### 7.4 增强网格系统

| 规则               | 行号  | 当前 minmax          | 目标 minmax                     | 当前 gap | 目标 gap          |
| ------------------ | ----- | -------------------- | ------------------------------- | -------- | ----------------- |
| `.bili-grid`       | L803  | `minmax(200px, 1fr)` | `minmax(min(100%, 200px), 1fr)` | `16px`   | `var(--space-md)` |
| `.mode-grid`       | L1330 | `minmax(260px, 1fr)` | `minmax(min(100%, 260px), 1fr)` | `16px`   | `var(--space-md)` |
| `.settings-layout` | L1227 | `minmax(340px, 1fr)` | `minmax(min(100%, 340px), 1fr)` | `14px`   | `var(--space-sm)` |

`min(100%, Xpx)` 的作用：当容器宽度小于 Xpx 时，取容器宽度（100%），防止网格溢出。

---

## 8. 实施方案 — 阶段三：Container Queries 与精细化增强

> **目标**：引入 @container 容器查询、组件级适配、全屏专项优化、antd 断点对齐。  
> **改动范围**：global.css + main.tsx (ConfigProvider) + 页面容器组件。  
> **风险**：中 — 需确认 Electron Chromium 兼容性（已验证：Electron 33 内置 Chromium 130+，完全支持）。

### 8.1 容器查询定义

```css
/* 主内容区作为容器上下文 */
.app-content {
  container-type: inline-size;
  container-name: page;
}

/* 侧栏作为容器上下文 */
.focus-side,
.english-side {
  container-type: inline-size;
}
```

### 8.2 组件级 @container 规则

| 组件            | 所在页面  | 容器条件                             | 布局变化                  |
| --------------- | --------- | ------------------------------------ | ------------------------- |
| ModeCard        | 首页      | `@container page (min-width: 600px)` | 竖排 → 横排内容布局       |
| BiliCard        | 视频学习  | `@container page (min-width: 500px)` | 紧凑模式 → 展示完整元数据 |
| 表单字段        | 设置      | `@container (min-width: 500px)`      | 单列堆叠 → 多列并排       |
| Session bar     | 视频学习/英语 | `@container (min-width: 400px)`      | 换行排列 → 水平排列       |
| Stats card 内部 | 统计      | `@container page (min-width: 800px)` | 紧凑间距 → 宽松间距       |

**示例 — ModeCard 容器查询**：

```css
/* 默认：紧凑竖排（窄容器） */
.mode-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

/* 容器宽度 ≥ 600px 时：横排展开 */
@container page (min-width: 600px) {
  .mode-card {
    flex-direction: row;
    align-items: center;
    gap: var(--space-md);
  }
}
```

**示例 — 表单字段容器查询**：

```css
/* 默认：单列堆叠 */
.settings-row {
  flex-direction: column;
  align-items: stretch;
}

/* 容器宽度 ≥ 500px 时：左右排列 */
@container (min-width: 500px) {
  .settings-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}
```

### 8.3 全屏专项优化

| 场景                          | 优化策略                                                 |
| ----------------------------- | -------------------------------------------------------- |
| Ultrawide (> 1600px) 内容区域 | `max-width` 居中，两侧留白                               |
| Ultrawide 侧栏                | 封顶 280px，不随视口继续增大                             |
| Hero/计时器区域               | 通过 clamp 放大（`.focus-timer` 已有 clamp，对齐新尺度） |
| 弹窗/模态框                   | `width: clamp(320px, 50vw, 600px)` 保持比例一致          |

### 8.4 antd ConfigProvider 断点对齐

main.tsx ConfigProvider 扩展，使 antd 内置组件的响应式行为与项目断点体系一致：

```tsx
<ConfigProvider
  theme={{
    token: {
      colorPrimary: '#ff6b4a',
      colorBgBase: '#0f1115',
      // ... 现有颜色 token 保持
    },
    components: {
      Layout: {
        // Sider 行为对齐
      },
      Grid: {
        // Row/Col 断点对齐
      },
      Modal: {
        // 弹窗宽度行为
      },
    },
  }}
>
```

---

## 9. 组件级适配方案（逐页）

### 9.1 首页（HomePage）

| 元素                 | 当前                               | 目标                                          |
| -------------------- | ---------------------------------- | --------------------------------------------- |
| `.mode-grid`         | auto-fill, minmax(260px), gap 16px | minmax(min(100%, 260px)), gap var(--space-md) |
| `.mode-card` padding | `20px 22px`                        | `var(--space-lg)`                             |
| ModeCard 布局        | 固定竖排                           | `@container page (min-width: 600px)` → 横排   |
| `.stats-bar` 间距    | 固定                               | 流体 clamp                                    |
| 内容区域             | 无 max-width                       | max-width: var(--content-max)                 |

### 9.2 专注模式（FocusPage）

| 元素                  | 当前                     | 目标                          |
| --------------------- | ------------------------ | ----------------------------- |
| `.focus-layout`       | flex row, 固定           | @media 堆叠/双栏切换          |
| `.focus-side`         | width: 320px             | clamp(240px, 22vw, 340px)     |
| `.focus-timer`        | clamp(72px, 12vw, 120px) | 对齐 --text-2xl 尺度          |
| `.focus-controls` gap | 12px                     | var(--space-sm)               |
| 内容区域              | 无 max-width             | max-width: var(--content-max) |

### 9.3 英语学习（EnglishModePage）

| 元素                         | 当前                                  | 目标                                |
| ---------------------------- | ------------------------------------- | ----------------------------------- |
| `.english-layout`            | flex row, height: calc(100vh - 200px) | @media 堆叠/双栏 + 保留 height calc |
| `.english-side`              | width: 300px                          | clamp(220px, 20vw, 320px)           |
| `.english-layout` gap        | 16px                                  | var(--space-md)                     |
| `.ai-settings`               | width: 280px                          | clamp(200px, 18vw, 300px)           |
| `.chat-msg-bubble` max-width | 82%                                   | 保留                                |
| 内容区域                     | 无 max-width                          | max-width: var(--dashboard-max)     |

### 9.4 视频学习（BiliModePage）

| 元素                   | 当前                               | 目标                                          |
| ---------------------- | ---------------------------------- | --------------------------------------------- |
| `.bili-grid`           | auto-fill, minmax(200px), gap 16px | minmax(min(100%, 200px)), gap var(--space-md) |
| `.bili-search-input`   | max-width: 460px                   | 保留                                          |
| `.bili-search-bar` gap | 10px                               | var(--space-sm)                               |
| BiliCard 内部          | 固定布局                           | @container 适配紧凑/展开                      |
| Session bar            | 固定布局                           | @container 适配换行/水平                      |
| 内容区域               | 无 max-width                       | max-width: var(--dashboard-max)               |
| 全屏模式               | win.setFullScreen(true)            | 内容居中 + max-width 约束                     |

### 9.5 学习统计（StatsPage）

| 元素                | 当前         | 目标                            |
| ------------------- | ------------ | ------------------------------- |
| `.stats-layout` gap | 14px         | var(--space-sm)                 |
| `.stats-card` 标题  | 固定字号     | var(--text-lg)                  |
| 图表区域            | 无 max-width | max-width: var(--dashboard-max) |
| 热力图单元格        | 固定         | 保持 aspect-ratio，clamp 间距   |

### 9.6 记事本（NotesPage）

| 元素     | 当前         | 目标                          |
| -------- | ------------ | ----------------------------- |
| 内容区域 | 无 max-width | max-width: var(--content-max) |
| 字号     | 固定         | 流体 clamp                    |
| 间距     | 固定         | 流体 clamp                    |

### 9.7 设置（SettingsPage）

| 元素               | 当前                              | 目标                                          |
| ------------------ | --------------------------------- | --------------------------------------------- |
| `.settings-layout` | auto-fit, minmax(340px), gap 14px | minmax(min(100%, 340px)), gap var(--space-sm) |
| `.settings-row`    | 固定 row                          | @container 单列/多列切换                      |
| `.settings-label`  | font-size: 13px                   | var(--text-sm)                                |

---

## 10. 技术实现蓝图

### 10.1 CSS 技术选型矩阵

| 技术                   | 适用场景         | 解决的核心问题                   | Electron 33 支持 |
| ---------------------- | ---------------- | -------------------------------- | ---------------- |
| Container Queries      | 组件级自适应     | 同一组件在不同容器中呈现不同布局 | Chromium 130+ ✅ |
| `clamp()`              | 字号、间距、尺寸 | 无级连续缩放，消除断点跳跃       | ✅               |
| `min()` / `max()`      | 尺寸上下限控制   | 确保元素不小于/不大于某个值      | ✅               |
| CSS Grid `auto-fit`    | 卡片网格         | 零断点自动列数调整               | ✅               |
| Viewport Units (vw/vh) | Hero、全屏面板   | 元素尺寸与视口联动               | ✅               |
| Media Queries          | 页面级布局       | 整体结构切换                     | ✅               |

### 10.2 关键技术模式

**模式一：流体内容容器**

```css
.app-content {
  width: 100%;
  max-width: var(--content-max, 1200px);
  margin-inline: auto;
  padding-inline: clamp(1rem, 3vw, 3rem);
}
```

**模式二：自适应网格（零断点）**

```css
.bili-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
  gap: var(--space-md);
}
```

**模式三：容器查询组件适配**

```css
.page-section {
  container-type: inline-size;
  container-name: section;
}

.data-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

@container section (min-width: 500px) {
  .data-card {
    flex-direction: row;
    gap: var(--space-md);
  }
}
```

### 10.3 布局模式对比

| 维度      | 当前方案（固定 px）        | 目标方案（流体 + 容器查询）        |
| --------- | -------------------------- | ---------------------------------- |
| 宽度定义  | 固定 px 值                 | 百分比 + max-width + clamp()       |
| 网格列数  | auto-fill 固定 minmax      | auto-fit + min(100%, ...)          |
| 组件复用  | 同一组件不同位置需覆写样式 | 容器查询自动适配，一处定义处处可用 |
| 窗口↔全屏 | 无适配，布局失调           | 平滑过渡，无感知切换               |
| 维护成本  | 高：间距/字号散落各处      | 低：token 集中管理                 |

---

## 11. 实施路线图

### 11.1 分阶段推进

| 阶段    | 周期  | 目标         | 关键产出                                               | 风险                              |
| ------- | ----- | ------------ | ------------------------------------------------------ | --------------------------------- |
| 一·基础 | 5 天  | 建立流体基础 | Design Token 系统、clamp() 排版、app-content max-width | 低：改动集中在 CSS 变量和全局样式 |
| 二·核心 | 10 天 | 核心布局改造 | Sider 自适应、@media 断点、侧栏 clamp、网格增强        | 中：涉及核心组件，需回归测试      |
| 三·增强 | 8 天  | 精细化增强   | @container 容器查询、全屏优化、antd 断点对齐           | 中：需验证组件级适配效果          |

### 11.2 各阶段关键交付物

| 阶段 | 交付物                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------- |
| 一   | `:root` Design Token（间距/字号/上限/断点）、流体排版规则、内容区域 max-width 规范                  |
| 二   | 自适应 Sider（App.tsx + global.css）、3 条 @media 断点规则、侧栏 clamp 宽度、网格 clamp gap + min() |
| 三   | @container 定义与组件级规则、全屏专项优化、antd ConfigProvider 断点对齐                             |

---

## 12. 验证策略

### 12.1 测试矩阵

| 测试维度      | 覆盖范围                                      | 验证要点                                |
| ------------- | --------------------------------------------- | --------------------------------------- |
| 视口宽度      | 940px, 1024px, 1280px, 1440px, 1920px, 2560px | 每个宽度下布局完整、无溢出、无过度拉伸  |
| 窗口↔全屏切换 | F11 全屏切换、窗口拖拽缩放                    | 切换过程平滑无跳变，布局立即重新计算    |
| 浏览器        | Electron 内置 Chromium                        | Container Queries、clamp() 等新特性兼容 |
| 操作系统      | Windows                                       | 字体渲染、滚动条宽度差异不影响布局      |
| 设备像素比    | 1x, 2x, 3x (HiDPI)                            | 布局精度不受影响                        |

### 12.2 关键检查点

- [ ] **文本行长度**：全屏模式下正文行长度不超过 75 字符（中文约 35–40 字）
- [ ] **卡片网格列数**：全屏模式下自动增加列数，卡片尺寸保持合理（不出现 500px+ 超大卡片）
- [ ] **间距节奏**：窗口和全屏模式下间距比例协调，不出现"窗口下挤、全屏下空"
- [ ] **导航栏宽度**：全屏下侧边栏宽度有上限（280px），不随视口继续增大
- [ ] **弹窗比例**：弹窗在窗口和全屏下视觉比例一致
- [ ] **无横向滚动条**：除数据表格等合理场景外，页面不应出现意外的横向滚动条
- [ ] **切换平滑性**：从窗口拖拽到全屏的过程中，布局过渡自然，无瞬间跳变

### 12.3 验证方法

- Chrome DevTools 的 Device Toolbar 手动拖拽视口宽度
- 全局 grep 验证 CSS 规则变更（`@media`、`@container`、`clamp`、`--space-` 等）
- `npx tsc --noEmit` 确保类型安全
- 逐页截图对比（940px vs 1920px）

---

## 13. 边界条件与风险

| 类别            | 说明                                                    | 缓解措施                                                    |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| 边界条件        | 主窗口 minWidth 940px，Compact 断点 (<768px) 实际不触发 | 保留 Compact 在 token 中供未来；Medium 断点为实际最小触发点 |
| 浏览器兼容      | Electron 33 内置 Chromium 130+，完全支持 @container     | 无需 polyfill，已验证                                       |
| antd Sider 覆盖 | antd Sider 宽度由组件 prop 控制，非纯 CSS               | 协调 TSX prop (collapsible/collapsedWidth) + CSS max-width  |
| ScrollArea 兼容 | ScrollArea.tsx 用 ResizeObserver + 固定像素计算         | ResizeObserver 已感知容器变化；流体尺寸通过 token 传入      |
| 悬浮面板        | 固定 340x560 窗口排除                                   | 内部内容可复用流体排版 token，但不做容器查询                |
| 性能            | 频繁重算属性中过多 clamp() 可能导致布局抖动             | 限制 clamp 在排版/间距/尺寸，不在 ScrollArea JS 计算中使用  |
| 回归风险        | 同时改变所有间距/字号值可能导致视觉回归                 | 严格分三阶段推进，每阶段完成后回归测试                      |
| antd 内部样式   | antd 组件有内联断点，可能与自定义断点冲突               | 在 ConfigProvider 中统一 screenXS/screenMD/screenLG         |

---

## 14. 验收标准

| 编号  | 标准                                                                          | 验证方法                                      |
| ----- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| AC-1  | global.css `:root` 包含完整设计 token 系统                                    | grep `--space-` 和 `--text-` 变量返回 ≥ 10 条 |
| AC-2  | global.css 中 `font-size` 固定 `px` 值为 0（排除 `--font-mono` 和 antd 内部） | 全部替换为 clamp() 或 var(--text-*)           |
| AC-3  | `.app-content` 规则包含 `max-width` 和 `margin-inline: auto`                  | DevTools 计算样式验证                         |
| AC-4  | global.css 中至少 3 条 `@media` 规则（Medium/Wide/Ultrawide）                 | grep `@media`                                 |
| AC-5  | global.css 中至少 2 条 `@container` 规则                                      | grep `@container`                             |
| AC-6  | App.tsx 中 `<Sider>` 使用 `collapsible` 属性                                  | 代码检查                                      |
| AC-7  | `.focus-side`、`.english-side`、`.ai-settings` 使用 clamp()-based width       | CSS 规则检查                                  |
| AC-8  | 全部 3 个网格类 gap 使用 clamp/var()，minmax 使用 `min(100%, ...)`            | CSS 规则检查                                  |
| AC-9  | 1920px 全屏下内容区域居中，max-width 生效（阅读 ≤1200px，数据 ≤1600px）       | DevTools 验证                                 |
| AC-10 | 940px 最小窗口下，任何页面无横向滚动条                                        | DevTools 验证                                 |
| AC-11 | 从 940px 到 2560px 拖拽过程布局过渡平滑                                       | 手动验证                                      |
| AC-12 | `npx tsc --noEmit` 通过无类型错误                                             | 命令验证                                      |

---

## 15. 术语表

| 术语             | 含义                                       | 备注                            |
| ---------------- | ------------------------------------------ | ------------------------------- |
| Sider            | antd Layout 侧边导航栏，当前固定 220px     | 目标：collapsible + clamp       |
| app-content      | 主内容区域 CSS 类                          | 目标：max-width + 居中          |
| focus-layout     | 专注页两栏布局（主区 + .focus-side）       | 目标：clamp + @media            |
| focus-side       | 专注页右侧栏，固定 320px                   | 目标：clamp(240px, 22vw, 340px) |
| english-layout   | 英语学习页两栏布局                         | 目标：clamp + @media            |
| english-side     | 英语页右侧栏，固定 300px                   | 目标：clamp(220px, 20vw, 320px) |
| bili-grid        | 视频学习搜索结果卡片网格                       | 目标：clamp gap + min()         |
| mode-grid        | 首页模式卡片网格                           | 目标：同 bili-grid              |
| settings-layout  | 设置页卡片网格                             | 目标：同 bili-grid              |
| DesignToken      | CSS 自定义属性，定义间距/字号/尺寸流体尺度 | 新增                            |
| Breakpoint       | 内容驱动的视口宽度阈值                     | 新增：768/1200/1600px           |
| ContainerContext | 容器查询上下文                             | 新增：container-name: page      |
| OverlayApp       | 悬浮面板独立应用，固定 340x560             | 排除出自适应范围                |

---

## 16. 架构决策记录

### ADR 0001: 采用流体 + 容器查询的自适应布局方案

**Status**: Accepted  
**Date**: 2026-08-18

#### Context

番茄专注 Pro 当前的布局完全依赖固定像素（Sider 220px、focus-side 320px、english-side 300px）+ flex/grid 弹性，没有任何 @media 断点和 @container 查询，仅 1 处 clamp() 用法。在窗口模式和全屏模式之间切换时，会出现内容过度拉伸、卡片间距失调、侧栏比例失衡等问题。

#### Decision

采用「流体 + 容器查询」方案，而非传统的「固定 px + 媒体查询」方案：

1. **页面级**：引入 3 个内容驱动 @media 断点（Medium 768px / Wide 1200px / Ultrawide 1600px）
2. **区域级**：引入 @container 容器查询，让组件根据所在容器宽度自适应
3. **元素级**：使用 clamp() / min() / max() 实现字号、间距、尺寸的无级缩放
4. **约束**：内容区域设置 max-width（阅读 1200px / 数据 1600px），全屏下居中

**被否决的替代方案**：仅用 @media 媒体查询做断点适配。否决理由：组件无法感知自身容器宽度，同一组件放在窄侧栏和宽主区域时需要重复写不同的样式规则，维护成本高且违反设计文档的核心原则。

#### Consequences

- **正面**：布局从 940px 到 2560px+ 全程平滑过渡，消除窗口↔全屏切换时的布局跳变
- **正面**：组件可复用——同一组件在不同容器中自动适配，无需重复样式
- **正面**：CSS 逻辑集中、规则简洁，降低长期维护成本
- **负面**：引入新的 CSS 模式（Container Queries、clamp 表达式），需团队熟悉
- **负面**：同时改变全局间距/字号值可能导致视觉回归，需分阶段推进和回归测试
- **约束**：需在 antd ConfigProvider 中对齐内置断点，避免与自定义断点冲突
- **约束**：ScrollArea.tsx 的 JS 像素计算需与流体布局兼容（ResizeObserver 已有基础）

---

## 范围声明

| 范围             | 内容                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **In scope**     | 全部 7 个页面、主窗口布局、学习视频窗口、4 个核心原则、3 层策略架构、组件级适配、流体 token 系统、global.css 重构                         |
| **Out of scope** | 实际代码实现（本轮仅设计）、悬浮面板窗口（固定尺寸）、940px 以下窄屏/移动端、antd 主题色变更、主进程窗口管理变更、ScrollArea.tsx 内部重构 |

## 假设

1. Electron 33 内置 Chromium ≥ 130，完全支持 CSS Container Queries、clamp()、min()/max()——无需 polyfill
2. 主窗口实际宽度范围：940px–2560px+（minWidth: 940）
3. 学习视频窗口实际宽度范围：900px–全屏（min 900x560）
4. 设计文档的 Compact 断点（< 768px）对主窗口和 视频学习窗口均不触发，但保留在 token 系统中
5. 单文件 global.css 保持为唯一样式文件——不引入 CSS Modules / CSS-in-JS / Tailwind
6. antd Sider 可通过内置 `collapsible` + `collapsedWidth` 属性实现折叠
7. antd ConfigProvider 可通过 `theme.token` 覆盖内置断点

---

> **下一步**：用户确认本方案后，进入 `dev-plan` 出具体实施计划（改动顺序、依赖排期、文件级 diff 预估）。
