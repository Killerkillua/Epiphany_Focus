# 番茄专注 Pro — High 级问题详细报告

> **报告日期**：2026-08-22
> **审查范围**：全代码库（主进程 + 渲染进程 + 共享模块 + 工程化配置）
> **问题总数**：16 个 High 级问题
> **报告格式**：每个问题包含问题描述、问题位置、严重程度评估、潜在影响分析、问题复现步骤、初步原因分析

---

## 问题索引

| 编号 | 问题简述                                           | 涉及模块            |
| ---- | -------------------------------------------------- | ------------------- |
| H-01 | 所有 IPC handler 缺少参数运行时验证                | 主进程 / 安全       |
| H-02 | bcrypt 同步哈希阻塞主进程                          | 主进程 / 性能       |
| H-03 | 缺少全局 unhandledRejection 保护                   | 主进程 / 稳定性     |
| H-04 | 守护进程无认证机制，PID 文件可被伪造               | 主进程 / 安全       |
| H-05 | bili-image 自定义协议 bypassCSP 权限过大           | 主进程 / 安全       |
| H-06 | 全量解构 store 导致每秒全量重渲染                  | 渲染进程 / 性能     |
| H-07 | OverlayApp 与 LearningAssistantDrawer 大量重复逻辑 | 渲染进程 / 可维护性 |
| H-08 | NoiseEngine.emit() 拖拽时高频触发全量刷新          | 渲染进程 / 性能     |
| H-09 | OverlayApp 组件过大（639 行），职责过多            | 渲染进程 / 可维护性 |
| H-10 | SettingsPage 组件过大（652 行），表单逻辑耦合      | 渲染进程 / 可维护性 |
| H-11 | 英语模式与 视频学习模式 AI 对话逻辑重复                | 渲染进程 / 可维护性 |
| H-12 | 缺少 ESLint / Prettier 代码规范工具链              | 工程化              |
| H-13 | 缺少 CI/CD 配置                                    | 工程化              |
| H-14 | 核心业务模块测试覆盖为零                           | 测试                |
| H-15 | package.json 运行时依赖放错位置                    | 工程化              |
| H-16 | AiReply 接口命名空间冲突                           | 共享模块 / 类型安全 |

---

## H-01：所有 IPC handler 缺少参数运行时验证

### 问题描述

项目中所有 `ipcMain.handle` 的参数仅依赖 TypeScript 类型标注（如 `request: AiAskRequest`、`question: AiQuestion`），但 TypeScript 类型在运行时被完全擦除。渲染进程传入的参数如果不符合预期类型（如 `null`、`undefined`、畸形对象、超长字符串），主进程不会在入口处进行任何校验，直接将异常数据传递给业务逻辑层处理。

经统计，三个核心 IPC 注册文件中合计约 **57 个** `ipcMain.handle` 调用，仅 **1 个**（`telemetry.record`）做了基本的运行时类型检查（`typeof payload.domain !== 'string'`），其余 **56 个**全部仅依赖 TypeScript 类型标注，无任何运行时 schema 校验。

### 问题位置

| 文件路径                        | 行号                                                                                                                       | 涉及的 IPC 通道数 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `src/main/ai/index.ts`          | 36, 50, 62-89, 93-115, 125-128, 132, 134, 141, 145                                                                         | 9 个              |
| `src/main/enforcement/index.ts` | 264, 291, 296-306, 308, 324, 333, 347                                                                                      | 7 个              |
| `src/main/navigation/index.ts`  | 168, 174, 194, 199, 214, 220, 228, 231, 234, 237, 242, 248, 252, 260, 264, 268, 272, 277, 282, 286, 298, 305, 364-368, 385 | 24 个             |

唯一做了基本验证的处理器：

- `src/main/navigation/index.ts:399` — `telemetry.record` 检查了 `typeof payload.domain !== 'string'`

### 严重程度评估

**High** — 虽然不会直接导致安全漏洞（SQL 查询使用了参数化绑定），但属于安全防御纵深的重要缺口。渲染进程被 XSS 攻破后，攻击者可通过畸形参数触发运行时崩溃、写入脏数据、或利用业务逻辑缺陷。

### 潜在影响分析

| 影响维度       | 分析                                                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **功能稳定性** | 异常参数导致 `TypeError` 崩溃（如 `undefined.map is not a function`），IPC handler 抛出未捕获异常，渲染进程收到错误响应                                                                                               |
| **数据完整性** | 畸形对象可能绕过业务逻辑校验直接写入数据库（如 `playRecords.importData` 的 `filePath` 若为恶意路径可能导致路径遍历）                                                                                                  |
| **安全性**     | 虽然 SQL 注入被参数化查询防护，但业务逻辑层可能被绕过（如 `ai.englishAsk` 的 `question.requestId` 为 undefined 时流式事件无法正确关联；`enforce.applyDistractionPolicy` 的 `policy.blacklist` 不是数组时 `map` 报错） |
| **可调试性**   | 异常参数导致的错误堆栈指向深层业务代码而非 IPC 边界，增加排查难度                                                                                                                                                     |

### 问题复现步骤

1. 启动应用（`npm run dev`）
2. 打开开发者工具（DevTools）
3. 在 Console 中执行以下代码模拟畸形参数调用：
   ```javascript
   // 场景1：传入 null 作为参数
   window.api.invoke('ai:englishAsk', null)

   // 场景2：传入缺少必填字段的对象
   window.api.invoke('ai:englishAsk', { message: 'hello' }) // 缺少 requestId, scenario

   // 场景3：传入超长字符串
   window.api.invoke('ai:englishAsk', {
     requestId: 'x'.repeat(100000),
     scenario: 'free',
     message: 'y'.repeat(1000000)
   })

   // 场景4：传入错误类型
   window.api.invoke('enforce:applyDistractionPolicy', { blacklist: 'not-an-array' })
   ```
4. 观察主进程控制台输出 — 将出现 `TypeError` 或静默处理异常数据

### 初步原因分析

项目设计阶段以 TypeScript 类型系统作为 IPC 契约的"唯一防线"，认为 `ipcMain.handle` 的类型标注足以保证参数正确性。这在开发环境中成立（TypeScript 编译器会检查调用方），但忽略了 Electron 安全模型的核心前提——**渲染进程是不可信的**。一旦渲染进程被 XSS 攻破，攻击者的代码不受 TypeScript 约束，可以传入任意结构的参数。项目缺少统一的 IPC 参数校验中间件，每个 handler 各自处理（或忽略）参数校验，导致防护不一致。

---

## H-02：bcrypt 同步哈希阻塞主进程

### 问题描述

`emergencyExit.ts` 中使用了 `bcrypt.hashSync()` 和 `bcrypt.compareSync()` 进行恢复码的哈希和验证。bcrypt 的 cost factor 为 10，在现代 CPU 上单次哈希约需 50-100ms，比对约需 50-100ms。这些操作在 Electron 主进程（即 Node.js 事件循环主线程）中同步执行，期间整个主线程被阻塞——UI 动画冻结、IPC 响应排队、窗口事件无法处理。

### 问题位置

| 文件路径                                | 行号 | 代码                                              |
| --------------------------------------- | ---- | ------------------------------------------------- |
| `src/main/enforcement/emergencyExit.ts` | 30   | `const hash = bcrypt.hashSync(code, 10)`          |
| `src/main/enforcement/emergencyExit.ts` | 42   | `return !!code && bcrypt.compareSync(code, hash)` |
| `src/main/enforcement/emergencyExit.ts` | 64   | `if (bcrypt.compareSync(code ?? '', hash))`       |

### 严重程度评估

**High** — 不会导致数据损坏，但在安全敏感操作（设置/验证紧急退出码）时造成可感知的 UI 冻结，影响用户体验。若被恶意高频调用，可造成主进程拒绝服务。

### 潜在影响分析

| 影响维度     | 分析                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| **用户体验** | 设置恢复码时窗口冻结 50-100ms，用户可能感知到"卡顿"；紧急退出验证时同样冻结                                 |
| **性能**     | 主线程阻塞期间所有 IPC 请求排队，包括计时器 tick 事件，可能导致番茄钟计时短暂延迟                           |
| **安全**     | 攻击者若能触发高频 `emergency:setCode` 调用（通过 XSS），每次调用阻塞 100ms，10 次/秒即可使主进程接近无响应 |
| **可靠性**   | 阻塞期间若窗口尝试关闭或系统事件触发，可能产生竞态条件                                                      |

### 问题复现步骤

1. 启动应用（`npm run dev`）
2. 进入设置页面 → 强制控制 → 设置紧急恢复码
3. 输入恢复码并点击确认
4. 观察应用界面 — 设置恢复码的瞬间（约 50-100ms），界面动画/交互出现明显卡顿
5. 可通过 Performance 面板录制确认主线程长时间阻塞

更严重场景模拟：

1. 打开 DevTools Console
2. 快速连续调用 10 次：
   ```javascript
   for (let i = 0; i < 10; i++) {
     window.api.invoke('emergency:setCode', `code${i}`)
   }
   ```
3. 主进程将阻塞约 500-1000ms，期间 UI 完全无响应

### 初步原因分析

bcryptjs 库同时提供同步（`hashSync` / `compareSync`）和异步（`hash` / `compare`）API。开发时选择同步版本的原因可能是：(1) 调用方代码更简洁（无需 async/await）；(2) 恢复码设置/验证是低频操作，开发者认为短暂阻塞可接受。但忽略了两个关键点：(1) 即使低频操作，主线程阻塞也会影响计时器精度和窗口响应；(2) 同步操作被恶意调用时无法通过异步调度自然限流。

---

## H-03：缺少全局 unhandledRejection 保护

### 问题描述

Electron 主进程中存在大量异步操作（AI 网关调用、网络请求、SQLite 数据库操作、文件 I/O 等），其中部分异步 Promise 采用"发射后不管"模式（如 `void saveCacheIndex()`、`void recordTelemetry()`）。主进程入口 `index.ts` 未注册 `process.on('unhandledRejection')` 和 `process.on('uncaughtException')` 全局处理器，任何未被 catch 的 Promise rejection 将成为静默丢失的异常。

### 问题位置

| 文件路径            | 行号             | 说明                                                                                     |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `src/main/index.ts` | 全文（1-144 行） | 不存在 `process.on('unhandledRejection', ...)` 和 `process.on('uncaughtException', ...)` |
| `src/main/index.ts` | 91               | 仅注册了 `app.whenReady()`                                                               |
| `src/main/index.ts` | 132              | 仅注册了 `app.on('activate')`                                                            |
| `src/main/index.ts` | 140              | 仅注册了 `app.on('window-all-closed')`                                                   |

### 严重程度评估

**High** — 不会直接导致功能故障，但会使异步异常成为"沉默的杀手"——问题发生时无任何日志记录，排查困难。Node.js 15+ 版本中，unhandledRejection 默认会导致进程退出，可能造成应用意外崩溃。

### 潜在影响分析

| 影响维度       | 分析                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| **稳定性**     | Node.js 15+ 默认行为是 unhandledRejection 触发进程退出；当前项目使用的 Electron 33.x 内置 Node.js 20+，此行为已生效 |
| **可调试性**   | 异步异常无日志、无堆栈输出，开发者无法通过日志定位问题根因                                                          |
| **数据一致性** | 若异步写入操作（如 `void saveCacheIndex()`）失败且未处理，缓存索引可能与实际数据不一致                              |
| **用户体验**   | 应用可能在不定期时间点意外退出，用户无法理解原因                                                                    |

### 问题复现步骤

1. 在 `src/main/ai/gateway.ts` 的 `chat` 方法中模拟一个未 catch 的 Promise rejection
2. 或在 DevTools Console 中通过 IPC 触发一个会 reject 但未被 catch 的操作：
   ```javascript
   // 模拟：断开网络后调用 AI 问答，使网关请求 reject
   // 如果 gateway 内部某些路径未完整 catch，将触发 unhandledRejection
   window.api.ai.englishAsk({ requestId: 'test', scenario: 'free', message: 'test' })
   ```
3. 观察主进程控制台 — 若出现 `[DEP0018] DeprecationWarning: Unhandled promise rejections` 或进程直接退出，即确认缺少全局保护
4. 正常情况下应看到 `UnhandledPromiseRejection: This error originated either by throwing...` 警告或进程退出

### 初步原因分析

Electron 应用开发中，开发者通常关注渲染进程的错误边界（React Error Boundary），容易忽略主进程的全局异常保护。项目中的异步操作大多在内部做了 try/catch（如 `gateway.ts` 的 `chat` 方法），但"发射后不管"模式的 Promise（`void` 前缀调用）是盲区——这些 Promise 的内部如果 reject 且未 catch，就成为 unhandledRejection。开发时可能因为这些操作通常成功（如缓存写入在本地磁盘几乎不会失败），未暴露问题。

---

## H-04：守护进程无认证机制，PID 文件可被伪造

### 问题描述

番茄专注 Pro 的守护进程（guardian）通过 PID 文件检测主进程是否存活。PID 文件以明文形式存储在 `userData` 目录下，内容仅为进程 PID 数字。守护进程读取 PID 文件后使用 `process.kill(pid, 0)` 检测进程存活，无任何认证机制。此外，守护进程的 `relaunchCmd` 参数直接从命令行读取并 `spawn` 执行，无校验。

### 问题位置

| 文件路径                        | 行号    | 代码/说明                                                                                 |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `src/main/enforcement/index.ts` | 171     | `const pidFile = join(app.getPath('userData'), 'enforced.pid')`                           |
| `src/main/enforcement/index.ts` | 172     | `writeFileSync(pidFile, String(process.pid))` — 明文写入 PID，无签名                      |
| `src/main/enforcement/index.ts` | 179-183 | `spawn(...)` 拉起守护进程，传入 `--watch pidFile`                                         |
| `src/main/guardian/guardian.ts` | 34-44   | `isAlive()` 函数直接读取 PID 文件，无完整性校验                                           |
| `src/main/guardian/guardian.ts` | 57-61   | `if (pidFile && !isAlive(pidFile) && relaunchCmd) { spawn(relaunchCmd, ...) }` — 直接执行 |

### 严重程度评估

**High** — 需要本地恶意程序前提，但攻击成本低（仅需写一个文件），影响严重（可干扰守护行为或拉起任意程序）。当前 `relaunchCmd` 未从主进程传入（`--relaunchCmd` 参数未使用），自动拉起功能实际未启用，但 PID 文件仍可被利用。

### 潜在影响分析

| 影响维度     | 分析                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **安全**     | 本地恶意程序可：(1) 伪造 PID 文件写入不存在的 PID，使守护进程误判主进程已死并触发拉起；(2) 若 `relaunchCmd` 未来启用且可被控制，守护进程将拉起任意程序 |
| **功能**     | 攻击者可通过操纵 PID 文件干扰强制会话的守护机制，使强制引擎无法正常拉起或守护                                                                          |
| **信任边界** | PID 文件无签名/校验，守护进程盲目信任文件内容，违反"不信任外部输入"原则                                                                                |

### 问题复现步骤

1. 启动应用并进入强制会话（L1/L2 级别）
2. 确认 `enforced.pid` 文件已创建（路径：`%APPDATA%/pomodoro-focus-pro/enforced.pid`）
3. 终止主进程（任务管理器结束 Electron 进程）
4. 手动修改 `enforced.pid` 文件内容为一个不存在的 PID（如 `999999`）
5. 守护进程将检测到 PID 不存在（`process.kill(999999, 0)` 失败），判定主进程已死
6. 若 `relaunchCmd` 已配置，守护进程将尝试拉起；当前未配置则守护进程仅记录日志

### 初步原因分析

守护进程设计时主要关注"主进程崩溃后自动拉起"的功能完整性，安全认证作为次要考虑被延后。PID 文件采用最简单的明文数字格式，未加入共享密钥或数字签名。`relaunchCmd` 从命令行参数读取的设计本身是为了灵活性（允许不同启动方式），但缺少"仅允许拉起主进程自身"的硬约束。

---

## H-05：bili-image 自定义协议 bypassCSP 权限过大

### 问题描述

`bili-image://` 自定义协议在注册时设置了 `bypassCSP: true` 特权，这意味着通过该协议加载的资源完全绕过页面的内容安全策略（CSP）。虽然当前该协议仅用于加载 视频学习封面图片，但 `bypassCSP` 特权意味着任何通过 `bili-image://` 协议的请求都不受 CSP 约束，包括未来可能被扩展用于加载脚本、样式等资源。

### 问题位置

| 文件路径            | 行号  | 代码                                          |
| ------------------- | ----- | --------------------------------------------- |
| `src/main/index.ts` | 27-42 | `protocol.registerSchemesAsPrivileged([...])` |
| `src/main/index.ts` | 39    | `bypassCSP: true` — 关键问题行                |

关键代码：

```typescript
{
  scheme: 'bili-image',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    bypassCSP: true          // ← 第39行，权限过大
  }
}
```

### 严重程度评估

**High** — 当前不直接导致漏洞（仅用于图片），但 `bypassCSP` 是一个高风险特权，违反最小权限原则。若渲染进程被 XSS 攻破，攻击者可利用 `bili-image://` 协议绕过 CSP 加载恶意资源。

### 潜在影响分析

| 影响维度     | 分析                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **安全**     | CSP 是防御 XSS 的最后一道防线；`bypassCSP` 为该协议打开了后门。若渲染进程被 XSS 攻破，攻击者可通过 `bili-image://` 协议绕过 CSP 执行受限操作 |
| **扩展风险** | 未来若 `bili-image://` 协议扩展用途（如加载 HTML、脚本），`bypassCSP` 将成为 XSS 放大向量                                                    |
| **视频学习页面**  | 学习视频页面在 `webview`/`BrowserWindow` 中加载，该页面的 CSP 可能被 `bili-image://` 协议绕过                                                |

### 问题复现步骤

1. 启动应用，进入 视频学习模式
2. 搜索任意 学习视频，确认封面图正常加载（通过 `bili-image://` 协议）
3. 打开 DevTools → Network 面板，筛选 `bili-image://` 协议请求
4. 确认该协议请求的 Response Headers 中无 CSP 相关限制
5. 尝试在 DevTools Console 中通过 `bili-image://` 协议加载非图片资源（若协议 handler 未限制内容类型，将绕过 CSP）

### 初步原因分析

`bypassCSP: true` 可能是在开发时遇到了 CSP 阻止 `bili-image://` 协议加载图片的问题，作为快速解决方案添加了该特权。图片资源通常不需要绕过 CSP（CSP 的 `img-src` 指令可以配置允许自定义协议），但开发者可能选择了最简单的"绕过全部 CSP"而非配置精确的 CSP 指令。

---

## H-06：全量解构 store 导致每秒全量重渲染

### 问题描述

`FocusPage` 和 `SessionTimerBar` 组件直接从 Zustand store 全量解构多个字段。Zustand 的全量解构模式（`const { a, b, c } = useStore()`）会在 store 中**任何**字段变化时触发组件重渲染——即使组件实际只使用部分字段。番茄钟每秒触发 `timer:tick` 事件更新 `snapshot` 字段，导致这两个组件每秒全量重渲染一次。

### 问题位置

| 文件路径                                          | 行号  | 解构字段数 | 代码                                                                                                                                                              |
| ------------------------------------------------- | ----- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/pages/FocusPage.tsx`            | 25-38 | 12 个      | `const { snapshot, alwaysOnTop, distraction, justCompleted, init, start, pause, resume, stop, setAlwaysOnTop, setDistraction, clearCompleted } = useFocusStore()` |
| `src/renderer/src/components/SessionTimerBar.tsx` | 53-54 | 9 个       | `const { snapshot, mode: storeMode, justCompleted, init, start, pause, resume, stop, clearCompleted } = useSessionStore()`                                        |

### 严重程度评估

**High** — 在番茄钟高频更新场景下造成持续性能浪费。`SessionTimerBar` 在 视频学习页和英语学习页都使用，影响范围广。

### 潜在影响分析

| 影响维度   | 分析                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **性能**   | 每秒至少 2 个组件全量重渲染（FocusPage + SessionTimerBar），每次重渲染涉及完整组件树 diff 和 DOM 操作。在 视频学习模式下（视频播放 + 悬浮面板 + 会话计时条），CPU 占用明显增加 |
| **电池**   | 持续不必要的重渲染增加 CPU 占用，笔记本电池续航受影响                                                                                                                          |
| **扩展性** | 随着功能增加，store 字段更多，全量解构的组件每次 store 变化都全量重渲染，性能问题会随规模放大                                                                                  |

### 问题复现步骤

1. 启动应用，进入专注模式
2. 启动番茄钟计时
3. 打开 DevTools → Performance 面板，录制 10 秒
4. 分析录制结果 — 将看到 FocusPage 每 1 秒触发一次完整的 render + commit 周期
5. 在 React DevTools Profiler 中确认：每次 `timer:tick` 事件触发 FocusPage 和 SessionTimerBar 重渲染
6. 对比验证：将解构改为 selector 模式后重新录制，渲染次数将显著减少

### 初步原因分析

Zustand 官方文档同时支持两种使用模式：全量解构（`const { a, b } = useStore()`）和 selector 模式（`const a = useStore(s => s.a)`）。全量解构语法更简洁，开发时优先选择了简洁性。但 Zustand 的全量解构使用 `Object.is` 进行浅比较，store 对象引用变化时即触发重渲染。番茄钟的 `snapshot` 每秒更新一个新对象引用，导致所有全量解构的组件都触发重渲染。Zustand 官方推荐在高频更新场景使用 selector + `shallow` 比较来避免不必要的重渲染。

---

## H-07：OverlayApp 与 LearningAssistantDrawer 大量重复逻辑

### 问题描述

`OverlayApp`（视频学习悬浮面板）和 `LearningAssistantDrawer`（视频学习助手抽屉）两个组件包含几乎完全相同的业务逻辑，约 200+ 行重复代码。重复覆盖：笔记自动保存（500ms 防抖 + upsert + flush 草稿）、AI 流式问答（requestId 生成、chunk 事件订阅、历史消息截取、错误处理）、AI 回答记入笔记。两处使用不同的状态管理方式（OverlayApp 用 `useReducer`，Drawer 用 `useState`），维护成本翻倍。

### 问题位置

| 逻辑             | OverlayApp.tsx 行号 | LearningAssistantDrawer.tsx 行号 | 重复度 |
| ---------------- | ------------------- | -------------------------------- | ------ |
| 笔记自动保存防抖 | 264-294             | 80-110                           | ~95%   |
| AI 流式问答      | 370-409             | 112-164                          | ~90%   |
| AI 回答记入笔记  | 410-430             | 165-180                          | ~85%   |

差异仅在：

- 笔记 source 字段：`'overlay'` vs `'main'`
- requestId 前缀：`bili-` vs `drawer-`
- Drawer 多了 OCR / 导出 Markdown 能力
- 状态管理方式：`useReducer` vs `useState`

### 严重程度评估

**High** — 不会导致运行时错误，但严重影响可维护性。修 bug 时容易只修一边，导致两个入口行为不一致。

### 潜在影响分析

| 影响维度     | 分析                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| **可维护性** | 每次笔记逻辑或 AI 问答逻辑变更需在两处修改，漏改概率高                   |
| **一致性**   | 两处独立实现可能产生行为差异（如防抖时间、错误处理方式），用户体验不一致 |
| **测试**     | 需为两处分别编写测试，测试维护成本翻倍                                   |
| **代码体积** | 200+ 行重复代码增加代码库体积，影响新开发者理解速度                      |

### 问题复现步骤

1. 打开 `src/renderer/src/overlay/OverlayApp.tsx`，查看第 264-294 行（笔记防抖保存逻辑）
2. 打开 `src/renderer/src/components/LearningAssistantDrawer.tsx`，查看第 80-110 行
3. 逐行对比 — 两段代码逻辑结构几乎完全一致，仅变量名和 source 字段不同
4. 对比 AI 问答逻辑：OverlayApp 第 370-409 行 vs Drawer 第 112-164 行 — 同样高度重复

### 初步原因分析

OverlayApp 和 LearningAssistantDrawer 是 视频学习模式的两个入口（悬浮面板 vs 抽屉面板），功能需求高度重叠（笔记 + AI 问答）。开发时可能先实现了其中之一（推测为 OverlayApp），然后将代码复制到 LearningAssistantDrawer 并做少量适配。未在复制后提取共享逻辑为 hook/store，导致重复代码长期存在。上传的设计文档 `unified-ai-chat-design.md` 已提出了 `useAiChat` hook + `useNotes` hook 的统一方案，可作为修复参考。

---

## H-08：NoiseEngine.emit() 拖拽时高频触发全量刷新

### 问题描述

`NoiseEngine` 是全局单例，使用发布-订阅模式通知 UI 更新。每次 `setMasterVolume`、`setTrackVolume`、`setSettings`、`playPreset`、`stopAll` 操作都会同步调用 `emit()`，通知所有订阅者。在 `NoiseControl` 组件中，Slider 的 `onChange` 事件（拖拽时每帧触发）直接调用 `noiseEngine.setMasterVolume()` → `emit()` → 所有订阅组件（包括 NoiseControl 自身）全部重渲染。拖拽期间可能产生每秒 30-60 次重渲染。

### 问题位置

| 文件路径                                       | 行号  | 说明                                                                                  |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| `src/renderer/src/audio/engine.ts`             | 67-69 | `private emit(): void { for (const listener of this.listeners) listener() }` — 无节流 |
| `src/renderer/src/audio/engine.ts`             | 94    | `setMasterVolume` 末尾调用 `this.emit()`                                              |
| `src/renderer/src/audio/engine.ts`             | 107   | `setSettings` 末尾调用 `this.emit()`                                                  |
| `src/renderer/src/audio/engine.ts`             | 152   | `playPreset` 中调用 `this.emit()`                                                     |
| `src/renderer/src/audio/engine.ts`             | 170   | `stopAll` 中调用 `this.emit()`                                                        |
| `src/renderer/src/audio/engine.ts`             | 179   | `setTrackVolume` 末尾调用 `this.emit()`                                               |
| `src/renderer/src/components/NoiseControl.tsx` | 98    | Slider onChange → `noiseEngine.setMasterVolume(value / 100)`                          |
| `src/renderer/src/components/NoiseControl.tsx` | 117   | Slider onChange → `noiseEngine.setTrackVolume(track.key, value / 100)`                |

### 严重程度评估

**High** — 拖拽音量滑块时产生极高的渲染频率，CPU 占用显著增加，可能导致低端设备卡顿。

### 潜在影响分析

| 影响维度     | 分析                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------- |
| **性能**     | 拖拽音量滑块 1 秒内触发 30-60 次全量重渲染，每次涉及 Slider 组件渲染 + DOM diff + 事件回调      |
| **音频**     | 高频调用 `setMasterVolume` 可能导致 Web Audio API 的 `GainNode.gain` 频繁设置值，产生音频咔嗒声 |
| **电池**     | 持续高频渲染增加 CPU/GPU 占用                                                                   |
| **可扩展性** | 随着订阅者数量增加，每次 `emit()` 的开销线性增长                                                |

### 问题复现步骤

1. 启动应用，进入白噪音控制面板
2. 打开 DevTools → Performance 面板
3. 开始录制，快速拖拽主音量滑块来回 3 秒
4. 停止录制，分析 — 将看到密集的 rendering 事件（每秒 30-60 次）
5. 检查 NoiseControl 组件的订阅回调（第 36-40 行），每次 `emit()` 触发 3 个 `setState` 调用
6. 确认每次 `setState` 导致 NoiseControl 及其子组件全量重渲染

### 初步原因分析

`NoiseEngine` 采用经典的观察者模式（`addListener` / `emit`），这是脱离 React 生态的传统事件驱动设计。`emit()` 无任何节流/防抖，每次状态变化立即通知所有订阅者。在非交互场景下（如程序化设置音量）这是合理的，但在 Slider 拖拽这种高频交互场景下，每帧触发 `onChange` → `setMasterVolume` → `emit()` → 全量重渲染，形成性能瓶颈。React 生态中更合适的方案是使用 `useSyncExternalStore` + 细粒度 selector，或迁移到 Zustand store 天然支持 selector。

---

## H-09：OverlayApp 组件过大（639 行），职责过多

### 问题描述

`OverlayApp` 单文件 639 行，是一个"上帝组件"，混合了 7+ 种职责：窗口状态管理（展开/最小化/隐藏）、AI 对话完整逻辑（流式问答、历史消息、记入笔记）、笔记完整逻辑（列表、编辑、自动保存、重点标记、时间点标记）、学习会话计时同步、学习进度心跳（5 秒间隔）、视频操作（关闭、跳转、时间点标记）、useReducer 状态机（16 种 action type）。

### 问题位置

| 文件路径                                  | 总行数 | 关键区域行号                                                                                                                                                        |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/overlay/OverlayApp.tsx` | 639 行 | Action 类型定义：58-75；initialState：77-92；reducer 函数：94-188；useReducer 声明：191；笔记 CRUD：432-521；AI 问答：371-409；进度心跳：325-352；视频操作：482-521 |

16 种 action type：`snapshot`、`set-context`、`welcome`、`set-tab`、`set-ai-input`、`ask-start`、`ask-chunk`、`ask-done`、`ask-fail`、`set-notes`、`set-note-draft`、`note-upserted`、`note-save-settled`、`note-attach-id`、`note-removed`、`session-tick`

### 严重程度评估

**High** — 不会导致运行时错误，但严重影响可维护性和可测试性。修改任何一处功能都可能意外影响其他功能。

### 潜在影响分析

| 影响维度     | 分析                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **可维护性** | 639 行单文件，新开发者需要 30+ 分钟才能理解完整逻辑；修改笔记功能可能意外影响 AI 问答 |
| **可测试性** | 组件无法独立测试——测试笔记逻辑需要 mock AI 问答、进度心跳等无关依赖                   |
| **重渲染**   | useReducer 的任意 dispatch 都触发整个组件重渲染，639 行的组件树 diff 成本高           |
| **协作**     | 多人同时修改 OverlayApp 容易产生合并冲突                                              |

### 问题复现步骤

1. 打开 `src/renderer/src/overlay/OverlayApp.tsx`
2. 统计文件行数 — 639 行
3. 尝试在文件中定位"笔记自动保存"逻辑 — 需要在第 264-294 行（useEffect）和第 432-521 行（CRUD 函数）之间跳转
4. 尝试在文件中定位"AI 流式问答"逻辑 — 需要在第 370-409 行（askAi 函数）和 reducer 的 64-67 行（ask-* actions）之间跳转
5. 确认：一个文件中包含窗口管理、AI 对话、笔记、计时、视频操作等多种不相关职责

### 初步原因分析

OverlayApp 作为 视频学习模式的悬浮面板入口，开发时将所有相关功能直接内聚在单一组件中。初始版本可能功能简单（仅窗口 + 对话），但随着笔记、进度心跳、时间点标记等功能逐步追加，文件不断膨胀。每追加一个功能都"放在同一个文件里更方便"，未及时提取 hook 和子组件。上传的设计文档已提出 `useAiChat` + `useNotes` + `useSessionTick` hook 拆分方案。

---

## H-10：SettingsPage 组件过大（652 行），表单逻辑耦合

### 问题描述

`SettingsPage` 单文件 652 行，包含 8 个设置分组的全部表单逻辑 + 3 个弹窗。每个配置项的 `update()` 方法都走相同的"保存 → 重新加载设置"流程，代码模式高度重复。组件使用了 11 个 `useState` 管理各种局部状态。

### 问题位置

| 文件路径                                  | 总行数 | 关键区域                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/pages/SettingsPage.tsx` | 652 行 | useState 声明：92-107（11 个）；强制控制：270-317；番茄钟参数：319-324；视频学习模式：326-349；学习会话：351-364；AI设置：366-428；白噪音：430-444；数据管理：446-543；帮助改进：545-569；恢复码 Modal：572-594；反馈弹窗：597；恢复预览 Modal：600-647 |

### 严重程度评估

**High** — 影响可维护性和可测试性，但不影响运行时正确性。

### 潜在影响分析

| 影响维度     | 分析                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **可维护性** | 652 行单文件，修改某个设置分组时需要在大文件中定位；11 个 useState 增加状态管理复杂度 |
| **可测试性** | 测试某个设置分组的表单逻辑需要渲染整个 SettingsPage                                   |
| **重复代码** | 每个设置项的 update 方法模式相同（读取 → 设置 → 保存 → 重新加载），大量重复           |
| **性能**     | 任意设置变化触发整个 652 行组件重渲染                                                 |

### 问题复现步骤

1. 打开 `src/renderer/src/pages/SettingsPage.tsx`
2. 统计文件行数 — 652 行
3. 查看 11 个 useState 声明（92-107 行）
4. 查看 8 个设置分组的 Card 组件（270-569 行）
5. 对比各分组的 `update` 方法 — 模式高度重复：
   ```typescript
   // 每个分组都有类似代码
   const update = (entries: Record<string, unknown>) => {
     void window.api.settings.set(entries).then(() => loadSettings())
   }
   ```
6. 确认：修改 AI 设置分组的表单逻辑需要在 366-428 行区域操作，与数据管理（446-543）等无关分组混在同一文件

### 初步原因分析

SettingsPage 作为全局设置入口，开发时将所有设置分组集中在一个页面组件中。初始可能只有 3-4 个分组，随着功能迭代（视频学习模式、AI设置、备份管理、白噪音等）不断追加，文件膨胀至 652 行。每个分组的表单逻辑模式相似（读取设置 → 修改 → 保存 → 刷新），但未提取通用的 `useSetting(key)` hook 来消除重复。

---

## H-11：英语模式与 视频学习模式 AI 对话逻辑重复

### 问题描述

英语模式（`EnglishModePage`）和 视频学习模式（`OverlayApp` + `LearningAssistantDrawer`）各自维护独立的 AI 对话实现，包括：不同的消息类型定义（`ChatMessage` vs `ChatMsg`）、不同的 `MessageItem` 组件（一个内联定义在 EnglishModePage，一个在 ChatPane 中）、不同的流式问答订阅逻辑、不同的消息渲染逻辑。两套实现 80% 功能相同（Markdown 渲染、流式光标、用户/助手气泡），但操作按钮各自硬编码。

### 问题位置

| 文件路径                                     | 行号    | 说明                                                                                    |
| -------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `src/renderer/src/pages/EnglishModePage.tsx` | 65-137  | `MessageItem` 组件内联定义（MarkdownView + SourcesPanel + "加入生词本"/"语法要点"按钮） |
| `src/renderer/src/pages/EnglishModePage.tsx` | 159-170 | `handleSend` 函数（调用 englishStore.ask）                                              |
| `src/renderer/src/pages/EnglishModePage.tsx` | 218-226 | 消息列表渲染                                                                            |
| `src/renderer/src/overlay/ChatPane.tsx`      | 8-15    | `ChatMsg` 类型定义（与 ChatMessage 不兼容）                                             |
| `src/renderer/src/overlay/ChatPane.tsx`      | 53-109  | 消息渲染逻辑（MarkdownView + 流式 + "记入笔记"按钮）                                    |
| `src/renderer/src/store/englishStore.ts`     | 全文    | 流式问答状态管理（与 OverlayApp/LearningAssistantDrawer 的流式逻辑独立）                |

### 严重程度评估

**High** — 影响可维护性和跨模式一致性，但不影响各自模式的独立功能。

### 潜在影响分析

| 影响维度     | 分析                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| **可维护性** | AI 对话逻辑变更需在 3 处修改（englishStore、OverlayApp、LearningAssistantDrawer）           |
| **类型安全** | `ChatMessage` 和 `ChatMsg` 类型不兼容，无法互换；新功能（如消息编辑）需在两套类型中分别添加 |
| **组件复用** | `MessageItem` 组件无法跨模式复用，功能相同的渲染逻辑重复实现                                |
| **用户体验** | 英语模式和 视频学习模式的 AI 对话 UI 可能因实现不同而产生细微差异                               |

### 问题复现步骤

1. 打开 `src/renderer/src/pages/EnglishModePage.tsx`，查看第 65-137 行的 `MessageItem` 组件
2. 打开 `src/renderer/src/overlay/ChatPane.tsx`，查看第 53-109 行的消息渲染逻辑
3. 对比两处代码 — 都包含：Markdown 渲染、流式光标、用户/助手气泡布局，但类型不同、操作按钮不同
4. 对比消息类型：`englishStore.ts` 的 `ChatMessage`（有 `sources`、`queryWord`）vs `ChatPane.tsx` 的 `ChatMsg`（有 `welcome`）— 字段不兼容
5. 查看流式问答逻辑：englishStore 的 chunk 订阅（全局注册）vs OverlayApp/LearningAssistantDrawer 的 chunk 订阅（每次请求注册/取消）— 实现方式不同

### 初步原因分析

英语模式和 视频学习模式是两个独立开发的功能模块，各自有自己的 AI 对话需求。开发时未预判到对话逻辑的共性，各自从零实现。`ChatMessage` 和 `ChatMsg` 的字段差异（`sources`/`queryWord` vs `welcome`）反映了不同业务需求，但这些差异完全可以通过可选字段统一。上传的设计文档 `unified-ai-chat-design.md` 已提出完整的统一方案：统一 `ChatMessage` 类型 + `useAiChat` hook + 共享 `MessageList` 组件。

---

## H-12：缺少 ESLint / Prettier 代码规范工具链

### 问题描述

项目完全没有静态代码分析工具配置。不存在任何 ESLint 配置文件（`.eslintrc*` / `eslint.config.*`）、Prettier 配置文件（`.prettierrc*`）、`package.json` 中的 `eslintConfig`/`prettier` 字段、以及相关 devDependencies。代码规范完全依赖开发者自觉和 TypeScript 编译器的类型检查。

### 问题位置

| 位置                                                 | 说明                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| 项目根目录 `c:\root\Tomato time\pomodoro-focus-pro\` | 不存在任何 ESLint/Prettier 配置文件                                     |
| `package.json`                                       | 无 `eslintConfig`/`prettier` 字段，devDependencies 中无 eslint/prettier |

### 严重程度评估

**High** — 不影响当前功能，但严重影响长期代码质量保障和多开发者协作。

### 潜在影响分析

| 影响维度     | 分析                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **代码质量** | TypeScript 只检查类型，无法覆盖：未使用变量、复杂度限制、React hooks 依赖完整性、导入顺序等      |
| **一致性**   | 不同开发者的代码风格（缩进、引号、分号、命名）无法自动统一                                       |
| **潜在bug**  | ESLint 的 `react-hooks/rules-of-hooks` 和 `react-hooks/exhaustive-deps` 规则能预防常见 React bug |
| **循环依赖** | ESLint 的 `import/no-cycle` 规则能在 lint 阶段发现循环依赖                                       |
| **PR质量**   | 无 lint 门禁，PR 审查需人工检查格式和规范问题                                                    |

### 问题复现步骤

1. 在项目根目录执行 `ls .eslintrc* .prettierrc* eslint.config.* prettier.config.*` — 无文件
2. 在 `package.json` 中搜索 `eslint` — 无匹配
3. 运行 `npx eslint src/` — 将提示 "ESLint not found" 或无配置文件错误
4. 检查现有代码中的 ESLint 可检测问题：
   - `OverlayApp.tsx:293` 的 `eslint-disable-next-line react-hooks/exhaustive-deps`
   - `LearningAssistantDrawer.tsx:109` 的同类 eslint-disable
   - 这些 eslint-disable 注释说明开发者知道 ESLint 规则的存在，但项目未配置 ESLint

### 初步原因分析

项目使用 electron-vite + TypeScript，Vite 内置了 TypeScript 编译能力但不含 ESLint。开发时可能认为 TypeScript 的 `strict: true` 已足够保证代码质量，忽略了 ESLint 在代码规范和最佳实践检查上的补充作用。代码中的 `eslint-disable-next-line` 注释说明开发者参考过 ESLint 规则（可能来自 IDE 插件提示），但未在项目中正式配置。

---

## H-13：缺少 CI/CD 配置

### 问题描述

项目不存在任何 CI/CD 配置——无 `.github/workflows/` 目录、无 `.gitlab-ci.yml`、无 `Jenkinsfile`。代码质量保障完全依赖本地执行 `npm run typecheck` 和 `npm run test`，无法在 PR 提交时自动验证。

### 问题位置

| 位置       | 说明                   |
| ---------- | ---------------------- |
| 项目根目录 | 不存在 `.github/` 目录 |
| 项目根目录 | 不存在任何 CI 配置文件 |

### 严重程度评估

**High** — 不影响当前代码功能，但严重影响长期质量保障和团队协作效率。

### 潜在影响分析

| 影响维度     | 分析                                                                |
| ------------ | ------------------------------------------------------------------- |
| **质量保障** | 开发者可能忘记本地运行 typecheck/test，坏代码直接流入仓库           |
| **回归检测** | 无自动化回归测试，功能回归只能在手动测试中发现                      |
| **构建验证** | electron-builder 构建可能在不同平台产生不同结果，无 CI 无法自动验证 |
| **发布流程** | 无自动化发布流水线，发布需手动执行 `npm run build:win` 等命令       |
| **PR 审查**  | 审查者无法依赖 CI 状态判断 PR 质量，需手动拉取代码本地验证          |

### 问题复现步骤

1. 在项目根目录执行 `ls .github/` — 目录不存在
2. 搜索所有 CI 相关文件：`find . -name "*.yml" -path "*ci*" -o -name "Jenkinsfile" -o -name ".gitlab-ci.yml"` — 无结果
3. 模拟 PR 场景：故意引入一个类型错误（如将 `string` 赋值为 `number`），提交代码
4. 无 CI 拦截 — 代码可直接合入主分支
5. 只有在本地运行 `npm run typecheck` 时才会发现错误

### 初步原因分析

项目处于 0.1.0 早期版本，可能由单人开发，CI/CD 的价值在单人开发阶段不显著。随着项目成熟度提升和团队扩大，CI/CD 成为必不可少的质量保障基础设施。GitHub Actions 对公开仓库免费、对私有仓库有免费额度，配置成本极低。

---

## H-14：核心业务模块测试覆盖为零

### 问题描述

项目仅有 6 个测试文件、约 47 个测试用例。测试集中在存储层（`db.test.ts` 质量优秀）和 AI 网关（`gateway.test.ts`），但核心业务逻辑模块——强制引擎（enforcement）、导航模块（navigation）、守护进程（guardian）、计时器（timer）、学习会话（session）、白噪音引擎（audio）——完全没有测试覆盖。这些模块恰恰是业务复杂度最高、安全最敏感的部分。

### 问题位置

| 有测试的模块 | 测试文件                                      | 用例数 | 质量评价 |
| ------------ | --------------------------------------------- | ------ | -------- |
| 存储层       | `src/main/storage/db.test.ts`                 | ~30+   | 优秀     |
| AI 网关      | `src/main/ai/gateway.test.ts`                 | 5      | 良好     |
| 设置管理     | `src/main/storage/settings.test.ts`           | 5      | 良好     |
| 环境变量     | `src/main/env.test.ts`                        | 3      | 中       |
| 英语 store   | `src/renderer/src/store/englishStore.test.ts` | 2      | 中       |
| 设置默认值   | `src/shared/settings.test.ts`                 | 2      | 低       |

| **零测试的核心模块** | 路径                    | 业务关键性                                 |
| -------------------- | ----------------------- | ------------------------------------------ |
| 强制引擎             | `src/main/enforcement/` | 安全关键（锁定/解锁/紧急退出/守护进程）    |
| 导航模块             | `src/main/navigation/`  | 业务核心（视频学习搜索/播放/导航守卫/全屏锁定） |
| 守护进程             | `src/main/guardian/`    | 安全关键（进程守护/PID 检测）              |
| 计时器               | `src/main/timer/`       | 核心功能（番茄钟计时/暂停/恢复）           |
| 学习会话             | `src/main/session/`     | 核心功能（会话计时/进度追踪）              |
| 白噪音               | `src/main/audio/`       | 辅助功能（音频播放/无缝循环）              |

### 严重程度评估

**High** — 核心业务逻辑无测试保护，回归风险高，重构困难。

### 潜在影响分析

| 影响维度     | 分析                                                         |
| ------------ | ------------------------------------------------------------ |
| **回归风险** | 修改强制引擎或导航守卫逻辑时无测试保护，可能引入回归而不自知 |
| **重构困难** | 安全重构（如提取 hook、拆分组件）无测试验证行为一致性        |
| **安全验证** | 强制会话锁定/解锁、紧急退出等安全关键逻辑无自动化验证        |
| **文档缺失** | 测试也是一种文档——核心逻辑无测试意味着新开发者缺少行为参考   |

### 问题复现步骤

1. 列出所有测试文件：搜索 `*.test.ts` — 仅 6 个
2. 检查 `src/main/enforcement/` 目录 — 无 `*.test.ts` 文件
3. 检查 `src/main/navigation/` 目录 — 无 `*.test.ts` 文件
4. 检查 `src/main/timer/` 目录 — 无 `*.test.ts` 文件
5. 运行 `npm run test` — 仅执行 6 个测试文件中的 47 个用例
6. 尝试修改 `enforcement/index.ts` 中的锁定逻辑（如将 `isEnforcedLevel` 的判断条件改错）— 无测试拦截，错误直接进入运行时

### 初步原因分析

项目的测试从存储层开始（db.test.ts 质量极高，说明开发者有测试能力），但未向上扩展到业务逻辑层。可能的原因：(1) 业务逻辑模块依赖 Electron API 和 IPC，mock 成本高；(2) enforcement 和 navigation 等模块耦合度高（循环依赖），难以独立测试；(3) 开发节奏快，功能优先于测试。测试金字塔底部（纯函数/存储）较充分，中间层（业务逻辑）完全断层，顶层（组件/E2E）完全缺失。

---

## H-15：package.json 运行时依赖放错位置

### 问题描述

`package.json` 的 `dependencies` 仅包含 5 个包（bcryptjs、better-sqlite3、electron-store、openai、recharts），而 `devDependencies` 错误地包含了多个渲染层运行时必需依赖：`antd`、`react`、`react-dom`、`react-markdown`、`zustand`、`@ant-design/icons`。同时 `recharts`（同为 UI 库）放在 `dependencies` 中，分类不一致。

### 问题位置

| 文件路径       | 行号 | 错误分类的依赖                                                            |
| -------------- | ---- | ------------------------------------------------------------------------- |
| `package.json` | 31   | `"@ant-design/icons": "^5.6.1"` — 在 devDependencies（应为 dependencies） |
| `package.json` | 38   | `"antd": "^5.24.2"` — 在 devDependencies（应为 dependencies）             |
| `package.json` | 42   | `"react": "^18.3.1"` — 在 devDependencies（应为 dependencies）            |
| `package.json` | 43   | `"react-dom": "^18.3.1"` — 在 devDependencies（应为 dependencies）        |
| `package.json` | 44   | `"react-markdown": "^9.0.3"` — 在 devDependencies（应为 dependencies）    |
| `package.json` | 49   | `"zustand": "^5.0.3"` — 在 devDependencies（应为 dependencies）           |
| `package.json` | 28   | `"recharts": "^2.15.4"` — 在 dependencies（与上述 UI 库分类不一致）       |

### 严重程度评估

**High** — 不影响 electron-vite 打包（Vite 会 bundle 渲染层依赖），但影响依赖审计正确性和 `npm install --production` 场景。

### 潜在影响分析

| 影响维度     | 分析                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **生产安装** | `npm install --production`（或 CI 中仅安装 dependencies）时，渲染层运行时依赖不会被安装，若构建流程依赖 node_modules 中的包则失败 |
| **依赖审计** | 审计工具（如 `npm audit`）可能对 devDependencies 中的安全漏洞降级处理                                                             |
| **语义错误** | dependencies = 运行时必需，devDependencies = 仅开发时需要；当前分类违反语义                                                       |
| **一致性**   | `recharts`（UI 库）在 dependencies，`antd`（同类 UI 库）在 devDependencies，分类不一致                                            |

### 问题复现步骤

1. 读取 `package.json`，查看 `dependencies`（23-29 行）和 `devDependencies`（30-50 行）
2. 确认 `react`、`react-dom`、`antd`、`zustand` 等在 `devDependencies` 中
3. 模拟生产安装：`npm install --production` → 检查 `node_modules/` 中不含 `react` 等
4. 若此时尝试运行 `electron-vite build`（依赖 node_modules 中的 react），构建可能失败
5. 对比 `recharts`（dependencies）和 `antd`（devDependencies）— 同类 UI 库分类不一致

### 初步原因分析

Electron + electron-vite 项目中，渲染层代码由 Vite 打包 bundle，运行时不需要从 `node_modules` 动态加载依赖。因此开发者可能认为 `dependencies` 中只需包含主进程运行时依赖（better-sqlite3、electron-store 等），渲染层依赖放在 devDependencies 中"反正打包时会处理"。这种理解在 electron-vite 构建流程下功能正确，但违反 npm 语义规范，且在非打包场景（如直接运行未打包的代码）会出问题。

---

## H-16：AiReply 接口命名空间冲突

### 问题描述

两个共享模块文件都导出了名为 `AiReply` 的接口，但结构不兼容：`src/shared/bili.ts` 的 `AiReply` 有 `role` 字段且 `sources` 是 `string[]`；`src/shared/ai.ts` 的 `AiReply` 无 `role` 字段且 `sources` 是 `AiSource[]`（对象数组）。消费侧通过 `import type { AiReply as EnglishAiReply }` 重命名来规避编译冲突，但同名异构的设计容易导致维护者混淆。

### 问题位置

| 文件路径               | 行号    | 定义                                                                                  |
| ---------------------- | ------- | ------------------------------------------------------------------------------------- |
| `src/shared/bili.ts`   | 192-197 | `export interface AiReply { role: 'assistant'; content: string; sources?: string[] }` |
| `src/shared/ai.ts`     | 62-65   | `export interface AiReply { content: string; sources: AiSource[] }`                   |
| `src/main/ai/index.ts` | 4       | `import type { AiAskRequest, AiReply } from '../../shared/bili'` — 直接导入 bili 版本 |
| `src/main/ai/index.ts` | 10      | `AiReply as EnglishAiReply` — 从 ai 导入时显式别名避免冲突                            |

字段差异对比：

| 字段      | bili.ts AiReply    | ai.ts AiReply                  |
| --------- | ------------------ | ------------------------------ |
| `role`    | 必填 `'assistant'` | 无此字段                       |
| `content` | `string`           | `string`                       |
| `sources` | `string[]`（可选） | `AiSource[]`（必填，对象数组） |

### 严重程度评估

**High** — 不会导致运行时错误（TypeScript 编译时已通过别名规避），但严重影响类型安全性和可维护性。

### 潜在影响分析

| 影响维度     | 分析                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| **类型安全** | 维护者可能 import 错误的 `AiReply`，TypeScript 不会报错（因为两者同名），但运行时字段不匹配 |
| **可维护性** | 消费侧需要记住哪个 `AiReply` 来自哪个文件，增加认知负担                                     |
| **扩展性**   | 新增 AI 相关类型时需要避免与两个 `AiReply` 冲突，命名空间受限                               |
| **代码意图** | 两个同名但不同的接口传达了"它们是同一个东西"的错误信号，实际它们的用途不同                  |

### 问题复现步骤

1. 打开 `src/shared/bili.ts`，查看第 192-197 行的 `AiReply` 接口
2. 打开 `src/shared/ai.ts`，查看第 62-65 行的 `AiReply` 接口
3. 对比两个接口 — `role` 字段一个有一个无，`sources` 类型一个是 `string[]` 一个是 `AiSource[]`
4. 打开 `src/main/ai/index.ts`，查看第 4 行和第 10 行 — 通过 `as EnglishAiReply` 别名规避冲突
5. 尝试移除别名直接 `import { AiReply } from '../../shared/ai'` — TypeScript 将报 "Duplicate identifier" 或导入歧义错误

### 初步原因分析

视频学习模式和英语模式的 AI 回复结构有细微差异（视频学习需要 `role` 字段标记角色，英语模式需要 `AiSource[]` 对象数组作为 RAG 来源）。两个模块独立开发时各自定义了 `AiReply`，未协调命名。发现冲突后通过 import 别名（`EnglishAiReply`）绕过，但未从根源解决——应将 视频学习版本重命名为 `BiliAiReply`，英语版本重命名为 `EnglishAiReply`，或将 AI 相关类型统一收归 `shared/ai.ts`。

---

## 附录：问题严重程度分级标准

| 级别         | 定义                                                 | 本报告对应问题         |
| ------------ | ---------------------------------------------------- | ---------------------- |
| **Critical** | 必须立即修复，涉及安全漏洞或核心功能失效             | （见 Critical 级报告） |
| **High**     | 应优先修复，涉及安全风险、性能问题、可维护性严重不足 | 本报告 16 个问题       |
| **Medium**   | 建议修复，影响代码质量和长期维护                     | （见 Medium 级报告）   |
| **Low**      | 可选优化，改善代码细节和规范                         | （见 Low 级报告）      |

---

## 附录：修复优先级建议

| 优先级 | 问题编号           | 修复建议                                       | 预计工作量 |
| ------ | ------------------ | ---------------------------------------------- | ---------- |
| P0     | H-01               | 引入 zod 对安全敏感 IPC 通道做参数校验         | 2 天       |
| P0     | H-14               | 优先补充 TimerService + enforcement 状态机测试 | 5 天       |
| P1     | H-02               | bcrypt 改为异步版本                            | 0.5 天     |
| P1     | H-03               | 注册全局 unhandledRejection 处理器             | 0.5 天     |
| P1     | H-06               | store 解构改为 selector 模式                   | 1 天       |
| P1     | H-08               | NoiseEngine emit 加 requestAnimationFrame 节流 | 0.5 天     |
| P1     | H-12               | 引入 ESLint + Prettier                         | 2 天       |
| P1     | H-13               | 配置 GitHub Actions CI                         | 1 天       |
| P2     | H-04               | 守护进程增加共享密钥认证                       | 1 天       |
| P2     | H-05               | 移除 bili-image bypassCSP                      | 0.5 天     |
| P2     | H-07 + H-09 + H-11 | 统一 AI 对话层（参考设计文档）                 | 5 天       |
| P2     | H-10               | SettingsPage 按分组拆分                        | 2 天       |
| P2     | H-15               | 修正 dependencies 分类                         | 0.5 天     |
| P2     | H-16               | AiReply 命名统一                               | 0.5 天     |

---

_报告生成时间：2026-08-22_
