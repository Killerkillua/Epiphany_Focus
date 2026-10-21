# 发布运行手册（灰度 / 回滚 / 镜像）

## 版本纪律

- 只修改 `package.json` 的 `version` 一处。
- 打 Git tag：`vX.Y.Z`，必须与 `package.json` 完全一致（`.github/workflows/release.yml` 版本守卫）。
- 更新 `CHANGELOG.md`：`[Unreleased]` → 新版本段；GitHub Release 说明与 CHANGELOG 该版本内容一致。

## 灰度发布

### 方式 A：Beta 通道（Pre-release）

1. 将 `package.json` 设为正式目标版本（如 `1.2.0`），CHANGELOG 写好 `[Unreleased]` 内容。
2. 打 tag：`v1.2.0-beta.1`（含 `-beta`），在 GitHub 创建 **Pre-release**。
3. CI 对含 `-beta` 的 tag 注入 `UPDATE_CHANNEL=beta`；客户端 `registerUpdater` 使用 `beta` 通道拉取该通道的 `latest.yml`。
4. 验证无问题后：同版本转正——打 **无 `-beta` 后缀** 的 tag `v1.2.0`（需与 `package.json` 一致），发 **Latest** 稳定版；beta 用户可切回 `UPDATE_CHANNEL=latest` 或安装正式包。

> **注意**：当前 tag 守卫要求 tag 名（去 `v` 前缀）等于 `package.json` version，因此 `v1.2.0-beta.N` 与 `1.2.0` 会在 CI 失败。Beta 发版前需临时放宽守卫、或 beta 使用独立 version 字段策略——以仓库实际 CI 配置为准；稳定发版仍用 `vX.Y.Z` = `package.json`。

### 方式 B：`latest.yml` 百分比灰度（electron-builder）

在 `electron-builder` 发布配置中为 `latest` 通道设置 `stagingPercentage`（如 `10`），仅部分客户端收到更新提示。逐步调高比例，最后设为 `100` 或移除该字段。详见 [electron-builder publish 文档](https://www.electron.build/configuration/publish)。

## 回滚

- 应用内 **`allowDowngrade=false`**（`createUpdater` 强制）：**禁止**通过更新渠道安装低于当前已装版本的包。
- **正确回滚**：在旧代码基线上 **提高 patch**（如 `1.2.1` → 回滚代码后发 `1.2.2`），修复问题后重新打包发布；用户在更高版本号上收到“修复版”而非降级包。
- **步骤概要**：
  1. `git checkout` 到已知良好 commit / tag。
  2. `package.json` version  bump 为 **大于** 线上坏版本的 patch（或 minor）。
  3. CHANGELOG + tag `vX.Y.Z` + 推送触发 Release。
  4. GitHub Release 说明中写明回滚原因与影响范围。

## SignPath 免费开源签名（Windows，第二档）

代码侧已就绪，默认关闭，未启用时仍走未签名 `--publish always` 发版，不阻塞节奏。

**启用前置（仓库外人工，缺一不可）**：

1. 完成转公开前历史泄密处置（吊销旧 API Key、gitleaks 全历史扫描、filter-repo 改写并强推、GitHub 残留对象清除），复核后把 `Killerkillua/Epiphany_Focus` 切 Public；
2. 在 signpath.org 提交开源项目申请并通过，在其控制台创建 project 与 signing policy 并绑定 GitHub 仓库；
3. 在 GitHub 仓库 Settings 配置：`secrets.SIGNPATH_API_TOKEN`，`vars.SIGNPATH_ORGANIZATION_ID`、`vars.SIGNPATH_PROJECT_SLUG`、`vars.SIGNPATH_SIGNING_POLICY_SLUG`，最后把 `vars.SIGNPATH_ENABLED` 设为 `true`。

**流水线行为（启用后，仅 Windows job）**：`electron-builder --win --publish never` 产出未签名包 → 上传 artifact → SignPath Action 签名并取回 → 覆盖回 `dist/` 并删失效的 `.exe.blockmap`（差分更新将走全量）→ `scripts/regen-latest-yml.mjs` 以签名后文件重算 `latest.yml` 的 sha512/size 并 `--check` 复核 → `gh release upload` 上传最终产物。禁止沿用签名前的 `latest.yml`。

**签名生效后**：Release 说明把 SmartScreen 段落改为「如遇系统提示点更多信息→仍要运行」保留一版，下一版再删（OV 级证书仍需积累信誉）。

## Gitee 镜像（备用下载）

- **应用内自动更新仍走 GitHub**（electron-updater / `latest.yml`）。
- 每个 GitHub Release 后，将安装包与 `latest.yml`（及 mac 的 `latest-mac.yml` 等）**同步到 Gitee 发行版**，供 GitHub 不可用时的手动下载。
- Release 说明中附上 Gitee 镜像链接。
- 有 `GITEE_TOKEN` 时可脚本化上传；无 token 时 **人工** 在 Gitee 创建对应版本并上传相同产物。

## 发布检查清单

发版前/后逐项确认（CI Summary 会输出同清单）：

- [ ] 系统托盘正常（最小化、右键菜单）
- [ ] 开机自启 `launchAtLogin` 行为符合预期
- [ ] 单实例锁：二次启动聚焦已有窗口
- [ ] **专注会话进行中** 时更新安装被拦截，会话结束后可安装
- [ ] 旧数据库 / 存储升级路径 smoke test
- [ ] **覆盖安装** 后用户设置与账号数据保留
- [ ] Windows SmartScreen / 未签名提示已在 Release 说明中告知用户
- [ ] Beta → 正式：通道、tag、Pre-release 标记与 CHANGELOG 已对齐
