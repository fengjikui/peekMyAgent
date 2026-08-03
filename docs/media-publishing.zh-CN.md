# 演示视频的存储与发布策略

本文规定 peekMyAgent 演示视频如何保存、审阅和发布。目标是让用户可以直接观看，同时不让每次 `git clone` 都下载频繁变化的成片与中间帧。

## 当前决策

- 主仓库跟踪：生成脚本、镜头表、字幕、封面、素材 manifest、脱敏说明和发布目录；
- 主仓库跟踪：可控 HTML 播放器和十章中文演示页；文档站点可直接部署这些静态文件；
- 主仓库可以跟踪：符合 `assets/demo/media-budget.json` 的确定性原图、双尺寸审阅图和紧凑 GIF；
- 主仓库不跟踪：MP4、独立旁白 M4A、逐镜头合成帧、临时片段和剪辑器缓存；
- 内部审阅：从主仓库脚本在本地生成成片，通过文件或临时链接审阅；
- 短期公开发布：优先使用 GitHub Releases 的 release asset；
- 长期公开发布：当视频数量、语言或访问量明显增长时，迁移到带 CDN 的对象存储；
- 可编辑工程：确有多人协作需要时可以放在独立素材仓库，但不以 Git submodule 作为用户播放入口。

GitHub 官方建议用 Releases 分发大型二进制，而不是把它们作为普通 Git 对象跟踪；单个 Release asset 必须小于 2 GiB，Release 的资产总大小和带宽当前没有硬性额度。[About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) · [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

长演示在文档中优先使用 `assets/demo/storyboard/index.html?embed=1&autoplay=0&timeline=...`：它支持暂停、拖动、逐镜头回看、字幕开关和全屏，避免 GIF 只能等待下一轮循环。统一入口是 `assets/demo/storyboard/gallery.zh-CN.html`。GitHub README 不能可靠执行仓库内 iframe，因此只放静态封面与公开演示链接；MP4 仍用于 B 站、YouTube 和其他社交媒体。

## 为什么暂不使用 Git LFS

Git LFS 能避免把二进制正文直接放入普通 Git 对象，但频繁改一小处视频时仍会上传一份完整的新版本；下载也计入仓库所有者的 LFS 带宽。对于会反复重剪、将来还会有多语言版本的视频，这不是默认的公开分发方案。[Git LFS billing](https://docs.github.com/en/billing/concepts/product-billing/git-lfs)

如果以后使用 LFS，只用于少量必须与某个 commit 严格共存的源工程，并先评估配额、fork 和 CI 下载行为。

## 为什么不把子模块当作播放器

独立素材仓库适合隔离剪辑源文件的权限和历史，但 submodule 会给贡献者增加初始化、固定 SHA 和更新步骤。它不能提供流媒体转码、缓存、Range 请求或稳定播放体验。因此：

- 可以有 `peekMyAgent-media-authoring` 一类的独立私有或受控仓库，保存剪辑工程；
- 主仓库只在维护文档中链接它，不把它设为普通用户构建或阅读 README 的依赖；
- 最终 MP4 仍发布到 Releases 或对象存储。

## 推荐的两阶段方案

### 阶段 A：GitHub Releases

在视频尚少、需要快速公开审阅时，创建独立的媒体 Release，例如 `docs-media-2026-08`。每个成片使用不可变文件名：

```text
pma-claude-tool-loop.zh-CN.<source-sha>.mp4
```

上传后把直链、SHA-256、字节数和对应产品 commit 写入 `assets/demo/video/catalog.json`。README 只引用 catalog 中已经发布并通过视觉验收的 URL，不引用本地被忽略的 MP4。

### 阶段 B：对象存储与 CDN

视频形成系列或开始多语言发布后，使用类似下面的不可变地址：

```text
https://media.peekmyagent.dev/videos/zh-CN/claude-tool-loop/<source-sha>/video.mp4
```

CDN 负责缓存和 Range 请求；catalog 负责从稳定视频 ID 指向当前通过验收的版本。不要覆盖同一个 URL 的文件，避免 README、浏览器缓存和旧文档看到不同内容。

## 发布流程

1. 从精确 `origin/main` SHA 生成确定性演示 Source；
2. 在 1920×1080 Viewer 视口重新操作并采集原始帧，同时生成 1024×576 文档宽度复核帧；
3. 运行生成脚本，得到本地 MP4、M4A、SRT、封面和时间线；
4. 对每个标注帧、成片中点抽帧、字幕、响度和隐私执行验收；
5. 计算 MP4 的 SHA-256 与字节数；
6. 上传到 GitHub Release 或对象存储；
7. 更新 catalog 的 `published_url`、`source_commit`、校验值与状态；
8. 在公开播放器与 GitHub README 降级入口分别检查，再把链接接入 README 或用户手册。

## 隐私与撤回边界

- 只发布确定性假上游或明确获准公开的 Capture；
- 不上传 API Key、认证 header、真实 System、真实源码、用户名或本地隐私路径；
- 上传前逐帧检查，并对字幕、旁白和封面单独检查；
- Release asset 和 CDN URL 一经公开就可能被缓存。发现泄露时先撤下对象并轮换凭据，再更新 catalog；不能把“删除 Git 记录”当作保密措施。

## 主仓库验收规则

- `git ls-files` 不应列出 `assets/demo/video/**/*.mp4`、`*.m4a`、`*.mp3`、`*.wav` 或生成帧目录；
- `assets/demo/media-budget.json` 当前把全部可追踪演示媒体限制为 80 MiB、单个 Source 章节限制为 12 MiB、单张静态图限制为 1.5 MiB、单个 GIF 限制为 8 MiB；达到 85% 时生产审计发出预警；
- 体积统计使用 `git ls-files --cached --others --exclude-standard`，因此既覆盖已提交文件，也覆盖下一次提交会纳入的未跟踪文件，同时排除按策略保留在本地的成片；
- catalog 中只有 `status: published` 的条目可以提供非空 `published_url`；
- 本地草稿可以记录校验值和输出路径，但 README 不得链接到被 `.gitignore` 排除的文件；
- 删除本地生成物后，仓库中保留的信息必须足以重新生成或明确列出需要重新采集的原始素材。

运行 `node scripts/demo-production-audit.mjs` 会执行上述格式和体积门禁；`smoke:governance` 也会调用同一审计。超过预算时，优先删除可重建重复帧、降低无损素材体积或把纯制作资料移到独立媒体工作区，不能只为让检查通过而无评审提高上限。
