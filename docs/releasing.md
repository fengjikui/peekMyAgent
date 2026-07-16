# peekMyAgent 发布手册

更新时间：2026-07-15

这份手册描述公开 npm 包和 GitHub Release 的发布流程。发布源必须是公开仓库
`fengjikui/peekMyAgent`，正式工作流不保存长期 npm Token。

## 发布契约

- `package.json`、`package-lock.json`、`CHANGELOG.md` 和 Git Tag 必须使用同一版本。
- Git Tag 固定为 `v<version>`，例如 `v0.1.0-alpha.2`。
- GitHub Release 发布后，工作流从该 Tag 精确 checkout，不从会继续移动的分支构建。
- Linux、macOS、Windows 三个平台全部通过同一候选 Tag 的 release profile 后，才允许 npm 发布。
- 预发布版本使用 npm `next` dist-tag；稳定版本才使用 `latest`。
- npm 发布 Job 使用 GitHub OIDC Trusted Publishing 和 provenance，不读取长期 `NPM_TOKEN`。
- GitHub `npm` Environment 是最后一道发布保护，可配置 Maintainer 审批和 Tag 限制。

## 首次引导发布

npm 目前要求包已存在，之后才能为它配置 Trusted Publisher。因此仅首次发布需要人工引导：

1. 在 npmjs.com 注册并启用双因素认证，确认 `peekmyagent` 名称仍可用。
2. 在干净工作树的候选提交上完成本机发布门禁，并确认托管三平台 CI 全绿。
3. 更新版本、锁文件和 Changelog；首次可使用当前的 `0.1.0-alpha.1`。
4. 创建并 checkout 对应 Tag，然后验证和预览包内容：

   ```bash
   npm run release:verify-version -- --tag=v0.1.0-alpha.1
   npm run smoke:package
   npm pack --dry-run
   ```

5. 使用维护者账号和 2FA 从该干净 Tag 手工发布首次 Alpha：

   ```bash
   npm login --registry=https://registry.npmjs.org/
   npm publish --registry=https://registry.npmjs.org/ --access public --tag next
   ```

6. 包存在后，在 npm 包设置的 **Trusted Publisher** 中绑定：

   ```text
   Provider: GitHub Actions
   Organization or user: fengjikui
   Repository: peekMyAgent
   Workflow filename: publish.yml
   Environment name: npm
   Allowed action: npm publish
   ```

7. 在 GitHub 创建名为 `npm` 的 Environment。建议只允许 `v*` Tag 部署，并启用发布审批。
8. 后续版本全部使用下面的 OIDC 流程。不要向仓库或 GitHub Actions 添加长期 `NPM_TOKEN`。

首次本机引导版本没有 GitHub OIDC provenance。它的目的只是建立 npm 包实体；从下一个
预发布版本开始，GitHub 托管 Runner 会自动生成可验证的来源证明。

## 后续可信发布

1. 从最新 `origin/main` 创建发布分支，更新版本、锁文件和 `CHANGELOG.md`。
2. 运行与改动风险匹配的聚焦测试；发布候选必须再运行当前主机完整 profile。
3. 推送候选提交，等待 `.github/workflows/release-check.yml` 三平台通过。
4. 为这个精确提交创建 `v<version>` Tag，并创建 GitHub Release。Alpha/Beta 必须标记为 prerelease。
5. 发布 Release 会触发 `.github/workflows/publish.yml`：
   - 再次从 Release Tag checkout；
   - 在三平台执行完整 release profile；
   - 校验 Tag、package、lock 和 Changelog；
   - 等待 `npm` Environment 审批；
   - 使用 OIDC 发布，并附带 provenance。
6. 发布后验证：

   ```bash
   npm view peekmyagent version dist-tags repository --json --registry=https://registry.npmjs.org/
   npm install --global peekmyagent@next --registry=https://registry.npmjs.org/
   pma doctor
   pma help
   ```

稳定版本将 `@next` 换成默认安装，并确认 `latest` 指向该稳定版本。

## 失败与回滚

- npm 版本不可覆盖。发布错误时不要重用同一版本号；修复后发布下一个 prerelease。
- 尚未进入 npm Publish Job：撤回 GitHub Release，修复后重新创建正确 Tag。
- 已发布但不可用：立即 `npm deprecate peekmyagent@<version> "reason"`，然后发布修复版本。
- `latest` 或 `next` 指向错误时，使用 `npm dist-tag` 修正，而不是删除历史版本。
- 不要用 `git push --force` 改写已经发布的 Tag；provenance 必须永久指向原始源码提交。

## 官方依据

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [npm trust CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
