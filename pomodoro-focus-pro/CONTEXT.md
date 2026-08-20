# Context

## Glossary

| Term | Meaning | Notes |
|---|---|---|
| Sider | antd Layout 侧边导航栏，当前固定 220px | 自适应方案目标：collapsible + clamp(220px, 15vw, 280px) |
| app-content | 主内容区域 CSS 类，当前 padding: 28px 32px 无 max-width | 目标：max-width + margin-inline: auto |
| focus-layout | 专注页两栏布局（主区 flex:1 + .focus-side 320px） | 目标：clamp 宽度 + @media 堆叠 |
| focus-side | 专注页右侧栏，固定 320px | 目标：width: clamp(240px, 22vw, 340px) |
| english-layout | 英语学习页两栏布局（聊天 flex:1 + .english-side 300px） | 目标：clamp 宽度 + @media 堆叠 |
| english-side | 英语页右侧栏，固定 300px | 目标：width: clamp(220px, 20vw, 320px) |
| bili-grid | B 站搜索结果卡片网格，auto-fill + minmax(200px, 1fr) | 目标：gap 改 clamp，minmax 加 min(100%, ...) |
| mode-grid | 首页模式卡片网格，auto-fill + minmax(260px, 1fr) | 目标：同 bili-grid |
| settings-layout | 设置页卡片网格，auto-fit + minmax(340px, 1fr) | 目标：同 bili-grid |
| DesignToken | CSS 自定义属性，定义间距/字号/尺寸的流体尺度 | 新增：--space-* / --text-* / --content-max / --dashboard-max |
| Breakpoint | 内容驱动的视口宽度阈值 | 新增：Compact(768px) / Medium(1200px) / Wide(1600px) |
| ContainerContext | 容器查询上下文，让组件感知所在容器宽度 | 新增：container-name: page 等 |
| OverlayApp | 悬浮面板独立应用，固定 340x560 不可调整大小 | 排除出自适应方案范围 |
