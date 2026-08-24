# 番茄专注 Pro 架构与工程化质量审查报告

> 审查日期：2026-08-22
> 审查范围：共享模块、工程化配置、测试覆盖、整体架构、preload 安全、文档质量
> 项目版本：0.1.0

---

## 一、整体架构评估

### 1.1 分层架构：基本合理，存在关键缺陷

项目采用标准的 Electron 三层架构（main / preload / renderer），分层思路正确：

- **主进程（src/main/）**：窗口管理、强制引擎、存储、AI 网关、导航管控等核心业务逻辑
- **preload 层（src/preload/）**：通过 contextBridge 暴露受限 API
- **渲染层（src/renderer/）**：React + Zustand UI 层，仅通过 window.api 与主进程通信
- **共享层（src/shared/）**：纯类型 + 常量，三层共用

**依赖方向基本正确**：main → shared ← preload → shared ← renderer

### 1.2 核心架构问题

#### 1.2.1 preload 反向依赖 main 模块（Critical）

preload 层不应依赖主进程内部实现，但当前：

- `src/preload/index.ts:3` 直接从 `../main/ipc` 导入 `IPC_CHANNELS`、`IPC_EVENTS`、`isAllowedChannel`、`isAllowedEvent`
- `src/preload/index.d.ts:1` 也从 `../main/ipc` 导入类型

这违反了 Electron 分层原则：preload 是渲染进程的一部分，不应加载主进程代码路径。虽然当前在构建时可能由打包工具处理，但语义上是错误的依赖方向。

**风险**：未来 main/ipc 若引入 Node.js 特有依赖（如 electron、fs 等），preload 构建会失败或引入安全风险。

#### 1.2.2 enforcement ↔ navigation 循环依赖（Critical）

主进程内部存在模块循环依赖：

- `src/main/enforcement/index.ts:20` → 从 `../navigation/biliWindow` 导入 `closeVideo`
- `src/main/navigation/index.ts:9` → 从 `../enforcement/emergencyExit` 导入 `assertExitSafety`
- `src/main/navigation/index.ts:56` → 从 `../enforcement` 导入 `EnforcementHandle` 类型

虽然当前通过函数参数注入（registerNavigationModule 接收 enforcement handle）缓解了运行时循环，但静态导入仍然存在双向依赖。

**风险**：模块初始化顺序敏感，重构时容易引入运行时错误；增加了模块间的耦合度。

#### 1.2.3 session 模块跨层耦合（High）

`src/main/session/index.ts` 同时依赖：

- `../navigation/biliWindow`（closeVideo, getVideoState）
- `../enforcement/lockScreen`（applyLevelWindow, releaseLevelWindow）

session 作为学习会话计时器，不应直接依赖 B 站视频窗口和强制引擎的锁屏实现。这种跨模块耦合使得 session 模块难以独立测试和复用。

### 1.3 模块边界评价

| 模块          | 内聚性 | 耦合度 | 评价                                             |
| ------------- | ------ | ------ | ------------------------------------------------ |
| timer/        | 高     | 低     | 优秀：纯计时逻辑，依赖注入回调                   |
| storage/db.ts | 高     | 中     | 良好：单一存储入口，但表数量多、职责重           |
| ai/           | 中高   | 低     | 良好：网关模式清晰                               |
| enforcement/  | 中     | 高     | 待改进：依赖 navigation、storage、timer 等多模块 |
| navigation/   | 中     | 高     | 待改进：依赖 enforcement、session、storage 等    |
| session/      | 中     | 高     | 待改进：同时依赖 navigation 和 enforcement       |

---

## 二、问题清单（按严重程度分级）

### Critical（严重）

#### C-1：preload 反向依赖 main/ipc 模块

- **文件**：`src/preload/index.ts:3`、`src/preload/index.d.ts:1`
- **问题**：preload 层从 `../main/ipc` 导入 IPC 通道常量和白名单校验函数，违反分层依赖方向。preload 属于渲染进程沙箱，不应引用主进程代码路径。
- **修复建议**：将 `IPC_CHANNELS`、`IPC_EVENTS`、`isAllowedChannel`、`isAllowedEvent` 迁移到 `src/shared/ipc.ts`（纯类型 + 常量 + 纯函数），main 和 preload 都从 shared 层导入。

#### C-2：enforcement 与 navigation 循环依赖

- **文件**：`src/main/enforcement/index.ts:20` ↔ `src/main/navigation/index.ts:9`
- **问题**：enforcement 导入 navigation 的 closeVideo，navigation 导入 enforcement 的 assertExitSafety 和 EnforcementHandle，形成双向依赖。
- **修复建议**：
  1. 将 `closeVideo` 调用改为通过事件回调注入（enforcement 不直接 import navigation）
  2. 或将 `assertExitSafety` 提取到独立的 shared 工具模块或 enforcement 内部子模块
  3. 建立明确的依赖方向：navigation → enforcement（导航模块使用强制引擎），enforcement 不依赖 navigation

#### C-3：统一 invoke 通道绕过类型化 API 边界

- **文件**：`src/preload/index.ts:78-83`
- **问题**：preload 暴露了通用 `invoke(channel, ...args)` 方法，虽然有白名单校验，但渲染层可以调用任意白名单内的 IPC 通道，绕过了类型化的命名 API（如 `api.bili.search()`、`api.ai.ask()`）。这削弱了 preload 作为安全边界的作用。
- **修复建议**：
  1. 考虑移除通用 `invoke` 方法，仅保留命名 API
  2. 或至少限制 `invoke` 仅用于调试/开发模式
  3. 若保留，确保所有调用优先使用命名 API，通用 invoke 仅作内部 fallback

### High（高优先级）

#### H-1：settings.set 接受任意路径写入，缺少写入权限控制

- **文件**：`src/preload/index.ts:251-252`、`src/main/storage/settings.ts:41-50`
- **问题**：`api.settings.set(entries: Record<string, unknown>)` 允许渲染层写入任意设置路径（点号路径）。如果渲染层被 XSS 攻破，攻击者可以修改关键安全设置（如 lockLevel、recoveryCodeHash 等）。
- **修复建议**：
  1. 定义明确的可写入设置白名单，区分"安全敏感设置"和"普通设置"
  2. 对安全敏感设置（如 lockLevel、recoveryCodeHash、enforced 状态）的写入增加额外校验
  3. 考虑拆分设置 API：`setDisplaySettings`、`setAISettings` 等粒度更细的接口

#### H-2：AiReply 接口命名冲突，bili.ts 和 ai.ts 各有一个

- **文件**：`src/shared/bili.ts:192-197`、`src/shared/ai.ts:62-65`
- **问题**：两个模块都定义了 `AiReply` 接口但结构不同。preload/index.ts 中通过 `import type { AiReply as EnglishAiReply }` 来重命名区分，说明命名空间冲突已存在。
- **修复建议**：
  1. 统一命名：`BiliAiReply` vs `EnglishAiReply`，或使用命名空间
  2. 或将 AI 相关类型全部收归到 `shared/ai.ts`，bili.ts 仅引用不重复定义

#### H-3：缺少 ESLint / Prettier 代码规范工具链

- **文件**：项目根目录（无 .eslintrc / .prettierrc）
- **问题**：项目无代码规范工具，长期多人协作会导致代码风格不一致、潜在 bug 无法静态捕获。TypeScript 编译器只能检查类型，无法覆盖代码质量规则。
- **修复建议**：
  1. 引入 ESLint + @typescript-eslint 插件，启用推荐规则集
  2. 引入 Prettier 统一代码格式化
  3. 配置 eslint-plugin-react 和 eslint-import 规则检查导入顺序和循环依赖

#### H-4：缺少 CI/CD 配置

- **文件**：无 .github/workflows/ 目录
- **问题**：没有自动化的类型检查、测试、构建流水线。代码质量完全依赖本地执行，容易出现"本地通过、CI 失败"或回归问题未及时发现的情况。
- **修复建议**：
  1. 配置 GitHub Actions（或等价 CI），至少包含：typecheck、test、build
  2. 配置 PR 检查规则，未通过 CI 的 PR 不可合并

#### H-5：核心模块测试覆盖严重不足

- **文件**：测试文件仅 6 个（项目共 ~60+ 源文件）
- **问题**：强制引擎（enforcement/）、导航模块（navigation/）、TimerService、session 模块、白噪音引擎等核心逻辑完全没有单元测试。这些模块恰恰是业务复杂度最高、最容易出 bug 的地方。
- **修复建议**：
  1. 优先为 TimerService、enforcement 状态机、navigation 守卫逻辑补充单元测试
  2. 为白噪音引擎（seamlessLoop、engine）添加测试
  3. 配置 vitest coverage 报告，设定覆盖率门槛

#### H-6：package.json 中运行时依赖放错位置

- **文件**：`package.json:31,38-44`
- **问题**：`antd`、`@ant-design/icons`、`react`、`react-dom`、`zustand`、`react-markdown`、`remark-gfm` 是渲染层运行时依赖，却放在 `devDependencies` 中。虽然 electron-vite 打包时会处理，但语义错误，且可能影响依赖审计。
- **修复建议**：将运行时依赖移动到 `dependencies`，仅构建工具和类型定义保留在 `devDependencies`。

### Medium（中优先级）

#### M-1：TypeScript 严格模式可进一步加强

- **文件**：`tsconfig.node.json:9`、`tsconfig.web.json:10`
- **问题**：已启用 `strict: true`，但缺少以下更严格的选项：
  - `noUncheckedIndexedAccess`：数组/对象索引访问不自动加 undefined
  - `noImplicitOverride`：防止意外覆写基类方法
  - `exactOptionalPropertyTypes`：可选属性不允许显式赋值 undefined
- **修复建议**：逐步启用上述严格选项，优先启用 `noUncheckedIndexedAccess`。

#### M-2：settings.set 中 `as never` 类型断言

- **文件**：`src/main/storage/settings.ts:45`
- **问题**：`s.set(key, value as never)` 使用 `as never` 绕过类型检查，这是 electron-store API 的类型限制导致的妥协，但掩盖了类型不匹配问题。
- **修复建议**：封装类型安全的 setSettings，使用 keyof AppSettings + 路径类型推导替代字符串点号路径 + `as never`。

#### M-3：缺少 Git hooks（提交前检查）

- **文件**：无 .husky/ 目录
- **问题**：没有 pre-commit / pre-push 钩子，无法在提交前自动运行 lint、typecheck、test，坏代码容易流入仓库。
- **修复建议**：引入 husky + lint-staged，配置 pre-commit 运行 lint-staged，pre-push 运行 typecheck + test。

#### M-4：renderer 使用相对路径 `../../../shared/` 导入共享类型

- **文件**：src/renderer/src/ 下多处（如 audio/synth.ts、overlay/OverlayApp.tsx 等）
- **问题**：虽然 tsconfig 配置了 `@renderer/*` 别名，但共享模块导入仍使用深层相对路径，路径冗长且脆弱。
- **修复建议**：在 tsconfig.web.json 的 paths 中增加 `@shared/*` 别名，指向 `src/shared/*`，渲染层统一用 `@shared/xxx` 导入。

#### M-5：constants.ts 中 MODE_LABELS/MODE_COLORS 键类型过于宽松

- **文件**：`src/shared/constants.ts:7,14`
- **问题**：使用 `Record<string, string>` 作为类型，丢失了类型安全。TypeScript 无法校验 key 是否为合法模式。
- **修复建议**：定义 `ModeKey = 'focus' | 'bili' | 'english'` 联合类型，使用 `Record<ModeKey, string>`。

#### M-6：electron-builder.yml 中 mac 未配置 notarize

- **文件**：`electron-builder.yml:25`
- **问题**：`notarize: false` 意味着 macOS 构建不会进行公证，用户下载后会被 Gatekeeper 拦截。
- **修复建议**：配置 Apple Developer ID 证书和 notarize 工具（如 `@electron/notarize`），生产构建启用公证。

#### M-7：主进程 BrowserWindow 配置 sandbox: false

- **文件**：`src/main/index.ts:64`
- **问题**：`sandbox: false` 降低了渲染进程的安全隔离级别。虽然 contextIsolation: true 提供了主要保护，但 sandbox 是 Chromium 的额外安全层。
- **修复建议**：评估是否可以启用 `sandbox: true`。如果 preload 不需要 Node.js API，应启用沙箱模式。

### Low（低优先级）

#### L-1：ADR 数量不足，缺少关键架构决策记录

- **文件**：`docs/adr/`（仅 0001 一篇）
- **问题**：项目架构复杂度高（强制引擎、四层导航判定、双计时体系、守护进程等），但仅 1 篇 ADR。关键决策如"为什么选 better-sqlite3 而非 IndexedDB"、"强制引擎的分层设计"、"为什么会话计时与专注计时分离"等都没有记录。
- **修复建议**：补充 3-5 篇核心 ADR，覆盖数据存储选型、强制引擎架构、进程模型、B 站接入方案等关键决策。

#### L-2：CONTEXT.md 仅覆盖 UI 术语，缺少架构上下文

- **文件**：`CONTEXT.md`
- **问题**：CONTEXT.md 全部是 UI 布局术语（Sider、断点、容器查询等），缺少项目架构概览、模块职责、关键约定等开发者需要的全局上下文。
- **修复建议**：扩展 CONTEXT.md，增加架构概览、模块图、IPC 契约约定、命名规范等内容。

#### L-3：缺少项目 README.md

- **文件**：项目根目录无 README.md
- **问题**：新开发者无法快速了解项目是什么、如何运行、如何构建、项目结构是什么。
- **修复建议**：编写 README.md，包含项目简介、功能特性、快速开始、构建命令、目录结构说明。

#### L-4：vitest.config.ts 未配置覆盖率

- **文件**：`vitest.config.ts`
- **问题**：没有配置 test.coverage，无法量化测试覆盖率。
- **修复建议**：添加 `@vitest/coverage-v8` 依赖，配置覆盖率报告输出和最低覆盖率阈值。

---

## 三、测试覆盖评估

### 3.1 测试现状

| 测试文件                                      | 测试对象                        | 用例数（约） | 质量评价                                                                   |
| --------------------------------------------- | ------------------------------- | ------------ | -------------------------------------------------------------------------- |
| `src/shared/settings.test.ts`                 | SETTINGS_DEFAULTS 默认值        | 2            | 低：仅验证默认值存在，非核心测试                                           |
| `src/main/env.test.ts`                        | parseEnvFile .env 解析          | 3            | 中：纯函数测试，覆盖基本场景                                               |
| `src/main/storage/settings.test.ts`           | electron-store 读写 + .env 回退 | 5            | 良好：覆盖回归场景、env 注入、点号路径更新                                 |
| `src/main/storage/db.test.ts`                 | SQLite 存储层（全量）           | ~30+         | 优秀：覆盖 study_stats、notes、play_records、feedback、backup 等全部核心表 |
| `src/main/ai/gateway.test.ts`                 | EnglishGateway 流式问答         | 5            | 良好：覆盖演示/真实模式、客户端缓存、错误处理                              |
| `src/renderer/src/store/englishStore.test.ts` | englishStore 配置加载           | 2            | 中：覆盖 init 和 settings:changed 刷新                                     |

**总计：约 47 个测试用例，6 个测试文件**

### 3.2 测试金字塔评估

```
        / E2E 测试 \          缺失
       / 集成测试   \         缺失
      / 组件测试     \        缺失（0 个组件测试）
     / 单元测试       \       不足（仅覆盖 storage/ai/env）
    / 纯函数测试       \      少量（parseEnvFile 等）
```

**测试金字塔严重底部偏重且中间断层**：

- 底层：纯函数 + 存储层测试较充分（db.test.ts 质量高）
- 中层：业务逻辑（enforcement、navigation、timer、session）完全无测试
- 顶层：组件测试、集成测试、E2E 测试完全缺失

### 3.3 测试亮点

1. **db.test.ts 质量很高**：使用临时 SQLite 文件隔离、覆盖边界条件、包含迁移回滚测试、备份恢复测试
2. **gateway.test.ts**：使用 vi.mock 工厂模式模拟 OpenAI 客户端，验证客户端缓存行为
3. **settings.test.ts**：包含回归测试（apiKey 空字符串遮蔽默认值），测试驱动修复

### 3.4 测试改进优先级

1. **最高优先级**：TimerService 单元测试（计时正确性、暂停恢复、番茄计数）
2. **高优先级**：enforcement 状态机测试（锁定/解锁、紧急退出、重启恢复）
3. **高优先级**：navigation guard 四层判定测试（URL 分类、黑白名单）
4. **中优先级**：白噪音引擎测试（seamlessLoop、交叉淡入淡出）
5. **中优先级**：渲染层组件测试（重点组件如 SessionTimerBar、ProgressCharts）

---

## 四、工程化成熟度评估

| 维度       | 评分 | 说明                                                                    |
| ---------- | ---- | ----------------------------------------------------------------------- |
| 类型安全   | 8/10 | strict: true 已开启，无 any 使用；但缺少 noUncheckedIndexedAccess 等    |
| 构建工具   | 7/10 | electron-vite 配置合理，双入口 + 别名；但缺少产物分析                   |
| 代码规范   | 2/10 | 无 ESLint / Prettier，完全依赖开发者自觉                                |
| 测试框架   | 6/10 | vitest 配置基本可用；但无覆盖率、核心模块无测试                         |
| CI/CD      | 0/10 | 完全缺失                                                                |
| Git 工作流 | 1/10 | 无 hooks，无提交规范                                                    |
| 依赖管理   | 5/10 | 版本锁定（package-lock.json）；但 dependencies/devDependencies 分类有误 |
| 打包发布   | 6/10 | electron-builder 配置三平台；但 macOS 未配置公证                        |

**综合工程化成熟度：4/10（初级偏上）**

项目在 TypeScript 类型安全和模块设计上有较好基础，但工程化工具链严重缺失，代码质量保障主要依赖人工审查。

---

## 五、preload 安全性评估

### 5.1 已做得好的方面

1. ✅ `contextIsolation: true` + `contextBridge.exposeInMainWorld` 标准用法
2. ✅ `nodeIntegration: false` 禁用 Node.js 集成
3. ✅ IPC 通道白名单机制（isAllowedChannel / isAllowedEvent）
4. ✅ 命名空间化的 API 设计（api.bili、api.ai、api.settings 等）
5. ✅ 类型定义文件与实现分离（index.d.ts）

### 5.2 安全隐患

| 风险项                       | 等级   | 说明                                          |
| ---------------------------- | ------ | --------------------------------------------- |
| 通用 invoke 方法             | High   | 渲染层可调用任意白名单通道，绕过命名 API 边界 |
| settings.set 任意路径写入    | High   | 点号路径可写入任意设置，包括安全敏感项        |
| sandbox: false               | Medium | 未启用 Chromium 沙箱，安全隔离有缺口          |
| channels/events 对象完整暴露 | Low    | 虽然是只读，但暴露了内部通道结构信息          |

### 5.3 安全建议

1. **移除通用 invoke** 或限制为仅开发模式可用
2. **拆分 settings API**，对安全敏感设置（lockLevel、recoveryCodeHash、enforced）增加写入校验
3. **评估启用 sandbox: true** 的可行性
4. **增加 IPC 参数校验**：主进程 ipcMain.handle 中对入参进行 schema 校验，不信任渲染层传入的数据

---

## 六、共享模块审查

### 6.1 总体评价

共享模块设计整体良好：

- ✅ 纯类型 + 常量 + 纯函数，无运行时副作用
- ✅ 文件按领域拆分（types、settings、ai、audio、bili、stats、backup、constants）
- ✅ 类型定义完整，无 any 使用

### 6.2 具体问题

| 文件                | 问题                                                                                           | 等级   |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| `types.ts`          | 只有 timer 和 session 相关类型，范围较窄；可考虑重命名为 `timer.ts` 或扩展为更通用的 `core.ts` | Low    |
| `settings.ts`       | SETTINGS_DEFAULTS 包含运行时常量值，放在 shared 层合理；但与 settings 类型定义在同一文件略混合 | Low    |
| `ai.ts` + `bili.ts` | AiReply 命名冲突（见 H-2）                                                                     | High   |
| `constants.ts`      | Record<string, string> 类型过宽（见 M-5）                                                      | Medium |
| `stats.ts`          | 文件较大（200 行），包含 play_records、study_sessions、feedback 多类类型；可考虑拆分           | Low    |
| `backup.ts`         | 独立文件避免循环引用，设计良好                                                                 | -      |

---

## 七、长期改进建议

### 7.1 架构层面（Roadmap 6-12 个月）

1. **建立清晰的依赖方向约束**
   - 引入 `eslint-plugin-import` + `import/no-restricted-paths` 规则，在 lint 阶段阻止非法依赖
   - 明确分层：shared（无依赖）→ storage（依赖 shared）→ 业务模块（依赖 shared + storage）→ 入口装配（index.ts）

2. **解耦 enforcement 和 navigation**
   - 通过事件总线或回调注入解除双向依赖
   - enforcement 只暴露接口，navigation 调用 enforcement，enforcement 不反向调用 navigation

3. **引入应用级事件总线**
   - 主进程内模块间通信从直接函数调用改为事件驱动
   - 降低模块间耦合，便于独立测试

4. **preload 层重构**
   - IPC 通道常量迁移到 shared/ipc.ts
   - 评估移除通用 invoke 方法
   - 建立 IPC 参数校验层（zod 或类似 schema 校验库）

### 7.2 工程化层面（Roadmap 1-3 个月）

1. **第 1 个月**：引入 ESLint + Prettier，配置基础规则，逐步修复存量问题
2. **第 1-2 个月**：引入 husky + lint-staged，配置 pre-commit / pre-push 钩子
3. **第 2 个月**：配置 GitHub Actions CI（typecheck + test + build）
4. **第 2-3 个月**：补充核心模块单元测试，目标覆盖率 60%+
5. **第 3 个月**：引入 vitest coverage，设定最低覆盖率阈值

### 7.3 测试层面（按优先级）

1. **P0**：TimerService 单元测试
2. **P0**：enforcement 状态机测试（锁定级别切换、紧急退出、冷却机制）
3. **P1**：navigation guard 四层判定测试
4. **P1**：白噪音引擎 seamlessLoop 测试
5. **P2**：渲染层核心组件测试（使用 @testing-library/react）
6. **P3**：端到端测试（使用 Playwright + Electron）

### 7.4 文档层面

1. 补充 README.md（项目介绍 + 快速开始）
2. 扩展 CONTEXT.md（架构概览 + 模块职责 + 命名约定）
3. 补充核心 ADR（至少 5 篇关键决策记录）
4. 考虑绘制架构图（Mermaid 或图片）

---

## 八、总结

### 优势

1. **分层思路正确**：main/preload/renderer 三层划分清晰，shared 层设计良好
2. **类型安全基础好**：TypeScript strict 模式，零 any 使用，类型定义完整
3. **存储层测试质量高**：db.test.ts 覆盖全面，包含迁移、边界、回归测试
4. **模块命名规范**：文件和变量命名一致，中文注释充分，可读性好
5. **IPC 契约设计**：通道命名规范、白名单机制、事件驱动模式正确

### 主要短板

1. **工程化工具链缺失**：无 lint、无 CI/CD、无 git hooks，质量保障依赖人工
2. **测试覆盖断层**：核心业务逻辑（enforcement、navigation、timer）无测试
3. **preload 安全边界不够严格**：通用 invoke + 任意 settings 写入是安全隐患
4. **模块耦合度偏高**：enforcement ↔ navigation 循环依赖，session 跨模块耦合

### 整体评分

| 维度       | 评分   | 权重 | 加权分     |
| ---------- | ------ | ---- | ---------- |
| 架构合理性 | 6.5/10 | 30%  | 1.95       |
| 类型安全   | 8.0/10 | 20%  | 1.60       |
| 测试质量   | 4.0/10 | 20%  | 0.80       |
| 工程化     | 4.0/10 | 20%  | 0.80       |
| 文档质量   | 3.5/10 | 10%  | 0.35       |
| **综合**   | -      | -    | **5.5/10** |

**结论**：项目处于"功能实现较完整、架构基础尚可、工程化薄弱"的阶段。核心业务逻辑已经落地且有一定设计质量，但缺少自动化质量保障体系。建议优先补齐工程化工具链（ESLint + CI）和核心模块测试，再逐步优化架构耦合问题。
