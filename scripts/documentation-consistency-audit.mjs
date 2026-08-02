#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

const chapterDocs = [
  "docs/user-guide/observe-session.md",
  "docs/user-guide/supported-harnesses.md",
  "docs/user-guide/requests-context.md",
  "docs/user-guide/tools-results.md",
  "docs/user-guide/skills.md",
  "docs/user-guide/subagents.md",
  "docs/user-guide/protocol-raw.md",
  "docs/user-guide/custom-harness.md",
  "docs/user-guide/privacy-cleanup.md",
  "docs/user-guide/troubleshooting.md",
];

const publicChineseDocs = [
  "README.zh-CN.md",
  "docs/user-guide.md",
  "docs/quick-start.zh-CN.md",
  ...chapterDocs,
];

const auditedPublicDocs = ["README.md", ...publicChineseDocs];

const cliFacts = [
  {
    help: "pma doctor",
    docs: ["README.md", "README.zh-CN.md", "docs/quick-start.zh-CN.md", "docs/user-guide/observe-session.md"],
  },
  {
    help: "pma open",
    docs: ["README.md", "README.zh-CN.md", "docs/quick-start.zh-CN.md", "docs/user-guide/observe-session.md"],
  },
  {
    help: "pma codex --dangerously-bypass-approvals-and-sandbox",
    docs: ["README.md", "README.zh-CN.md", "docs/quick-start.zh-CN.md", "docs/user-guide/privacy-cleanup.md"],
  },
  {
    help: "pma claude --dangerously-skip-permissions",
    docs: ["README.md", "README.zh-CN.md", "docs/quick-start.zh-CN.md", "docs/user-guide/privacy-cleanup.md"],
  },
  {
    help: "pma opencode --auto",
    docs: ["README.md", "README.zh-CN.md", "docs/quick-start.zh-CN.md", "docs/user-guide/privacy-cleanup.md"],
  },
  {
    help: "pma codebuddy --dangerously-skip-permissions",
    docs: ["README.md", "README.zh-CN.md", "docs/quick-start.zh-CN.md", "docs/user-guide/privacy-cleanup.md"],
  },
  {
    help: "pma observe --name my-agent --base-url-env OPENAI_BASE_URL",
    docs: ["README.md", "README.zh-CN.md", "docs/user-guide/custom-harness.md"],
  },
  {
    help: "pma shutdown",
    docs: ["README.md", "README.zh-CN.md", "docs/quick-start.zh-CN.md", "docs/user-guide/privacy-cleanup.md"],
  },
  {
    help: "pma clear --all-sessions",
    docs: ["README.md", "README.zh-CN.md", "docs/quick-start.zh-CN.md", "docs/user-guide/privacy-cleanup.md"],
  },
];

const impactRules = [
  {
    id: "cli-and-lifecycle",
    label: "CLI、安装和 wrapper 生命周期",
    patterns: [
      /^bin\//,
      /^scripts\/(?:install|uninstall|doctor|maintenance|run-|observe|daemon)/,
      /^src\/core\/(?:app-paths|platform|process-tools)/,
    ],
    docs: [
      "README.zh-CN.md",
      "README.md",
      "docs/quick-start.zh-CN.md",
      "docs/user-guide/observe-session.md",
      "docs/user-guide/supported-harnesses.md",
      "docs/user-guide/privacy-cleanup.md",
      "docs/user-guide/troubleshooting.md",
    ],
    demos: ["启动命令终端素材", "快速上手 Source"],
  },
  {
    id: "harness-capture",
    label: "Harness 捕获与 adapter",
    patterns: [
      /^(?:src|bin|integrations)\/.*(?:codex|claude|opencode|codebuddy|openclaw|observe|adapter)/i,
    ],
    docs: [
      "README.md",
      "README.zh-CN.md",
      "docs/user-guide/supported-harnesses.md",
      "docs/user-guide/custom-harness.md",
      "docs/user-guide/troubleshooting.md",
    ],
    demos: ["对应 Harness 的真实 CLI Source 与 manifest"],
  },
  {
    id: "timeline-navigation",
    label: "Viewer 时间线与两级导航",
    patterns: [
      /^src\/viewer\/.*(?:timeline|turn|request-card|session-navigator|router|pane-layout)/i,
    ],
    docs: [
      "README.md",
      "docs/quick-start.zh-CN.md",
      "docs/user-guide/observe-session.md",
      "docs/user-guide/requests-context.md",
    ],
    demos: ["主快速上手素材", "Turn / Request 两级导航素材"],
  },
  {
    id: "request-context",
    label: "请求详情与上下文变化",
    patterns: [
      /^src\/(?:viewer|trace)\/.*(?:upstream-detail|request-detail|history|context|system-diff|request-composition)/i,
    ],
    docs: [
      "README.md",
      "docs/user-guide/requests-context.md",
      "docs/user-guide/protocol-raw.md",
    ],
    demos: ["上下文变化 Source", "Context Delta / System diff 画面"],
  },
  {
    id: "context-lifecycle",
    label: "上下文压缩、重组与生命周期",
    patterns: [
      /^(?:src|scripts)\/.*(?:context-delta|context-chain|compact|compaction|system-diff|history)/i,
    ],
    docs: [
      "README.md",
      "docs/user-guide/requests-context.md",
      "docs/user-guide/protocol-raw.md",
      "docs/user-guide/tools-results.md",
    ],
    demos: [
      "Claude Code 上下文压缩 Source 与双尺寸审阅帧",
      "Codex 上下文压缩 Source、provider 边界与双尺寸审阅帧",
      "Context Delta / System diff 画面",
    ],
  },
  {
    id: "tools",
    label: "工具调用、结果与来源关联",
    patterns: [
      /^(?:src|scripts)\/.*(?:tool-call|tool-exchange|tool-result|response-correlation)/i,
    ],
    docs: ["README.md", "docs/user-guide/tools-results.md", "docs/user-guide/requests-context.md"],
    demos: ["快速上手工具闭环", "迟到工具结果素材"],
  },
  {
    id: "skills",
    label: "Skill 发现、加载与后续工具",
    patterns: [
      /^(?:src|scripts|integrations)\/.*(?:skill|slash-command)/i,
    ],
    docs: [
      "README.md",
      "docs/user-guide/skills.md",
      "docs/user-guide/supported-harnesses.md",
      "docs/user-guide/protocol-raw.md",
    ],
    demos: ["对应 Harness 的 Skill 真实 CLI Source 与双尺寸审阅帧"],
  },
  {
    id: "subagents",
    label: "子 Agent 与多 Agent 看板",
    patterns: [
      /^(?:src|scripts)\/.*(?:subagent|agent-graph|agent-composer|multi-agent)/i,
    ],
    docs: ["README.md", "docs/user-guide/subagents.md", "docs/user-guide/supported-harnesses.md"],
    demos: ["Claude Code 子 Agent Source 与双尺寸审阅帧"],
  },
  {
    id: "agent-planning",
    label: "Agent 机制流程与多步规划",
    patterns: [
      /^src\/viewer\/turn-story-/i,
      /^scripts\/.*(?:claude-planning|turn-story)/i,
    ],
    docs: [
      "README.md",
      "docs/user-guide/requests-context.md",
      "docs/user-guide/tools-results.md",
    ],
    demos: [
      "Claude Code 多步规划 Source 与双尺寸审阅帧",
      "工具、Skill、子 Agent、压缩机制流程代表帧",
    ],
  },
  {
    id: "protocol-and-raw",
    label: "协议投影、Raw Inspector 与 provenance",
    patterns: [
      /^src\/viewer\/.*(?:protocol|raw-|provenance)/i,
      /^src\/.*(?:protocol-exchange|provenance)/i,
    ],
    docs: ["README.md", "docs/user-guide/protocol-raw.md", "docs/user-guide/custom-harness.md"],
    demos: ["协议视图、Raw Inspector 与脱敏 JSON"],
  },
  {
    id: "translation-theme",
    label: "翻译、语言与主题",
    patterns: [
      /^src\/viewer\/.*(?:translation|language|theme|i18n)/i,
    ],
    docs: [
      "README.md",
      "README.zh-CN.md",
      "docs/user-guide/requests-context.md",
      "docs/visual-usage-guide.zh-CN.md",
    ],
    demos: ["translation 真实 Capture Proxy Source、原文对照帧与双尺寸审阅素材"],
  },
  {
    id: "demo-production",
    label: "演示 catalog、网页故事板、审片入口与媒体生产工具",
    patterns: [
      /^assets\/demo\/storyboard\//i,
      /^assets\/demo\/source\/[^/]+\/(?:manifest\.json|narration\.zh-CN\.md|video\/)/i,
      /^scripts\/.*(?:storyboard|demo-production|timeline-subtitles|demo-video)/i,
    ],
    docs: [
      "docs/demo-chapter-production.zh-CN.md",
      "docs/visual-usage-guide.zh-CN.md",
      "docs/video-production.zh-CN.md",
      "docs/documentation-maintenance.md",
    ],
    demos: ["统一章节 catalog、HTML 动效模板、本地审片首页、双尺寸复核帧与干净画面母版"],
  },
  {
    id: "privacy-data",
    label: "隐私、Trace、清理、导入导出",
    patterns: [
      /^(?:src|bin|scripts)\/.*(?:privacy|security|trace-bundle|import|export|clear|uninstall|retention)/i,
    ],
    docs: [
      "README.md",
      "README.zh-CN.md",
      "docs/user-guide/privacy-cleanup.md",
      "docs/user-guide/troubleshooting.md",
      "docs/user-guide/requests-context.md",
    ],
    demos: ["manifest 隐私字段与公开前检查"],
  },
];

export function runDocumentationConsistencyAudit({ log = true } = {}) {
  const summary = {
    documents: 0,
    links: 0,
    anchors: 0,
    chapters: chapterDocs.length,
    cliFacts: cliFacts.length,
    demoMappings: 0,
    demoReviews: 0,
  };

  for (const relativePath of auditedPublicDocs) {
    const absolutePath = resolveRepoPath(relativePath);
    assertFile(absolutePath, "public Chinese document");
    const result = auditMarkdownLinks(absolutePath);
    summary.documents += 1;
    summary.links += result.links;
    summary.anchors += result.anchors;
  }

  const userGuide = readRepoFile("docs/user-guide.md");
  assert.match(userGuide, /\[五分钟快速上手\]\(quick-start\.zh-CN\.md\)/);
  for (const chapter of chapterDocs) {
    const relativeFromIndex = path.posix.relative("docs", chapter);
    assert(
      userGuide.includes("(" + relativeFromIndex + ")"),
      "docs/user-guide.md must link chapter " + chapter,
    );
  }

  const storyboardCatalog = JSON.parse(readRepoFile("assets/demo/storyboard/catalog.zh-CN.json"));
  assert.equal(storyboardCatalog.schema_version, 4, "storyboard catalog schema_version must be 4");
  assert(Array.isArray(storyboardCatalog.chapters) && storyboardCatalog.chapters.length > 0,
    "storyboard catalog must contain chapters");
  for (const chapter of storyboardCatalog.chapters) {
    assert.match(chapter.guide || "", /^\/docs\//, `storyboard chapter ${chapter.id} needs a guide`);
    assert.equal(typeof chapter.guide_section, "string", `storyboard chapter ${chapter.id} needs a guide_section`);
    const guideRelative = chapter.guide.slice(1);
    assert(publicChineseDocs.includes(guideRelative),
      `storyboard chapter ${chapter.id} must map to an audited public Chinese document`);
    const headings = collectHeadingAnchors(readRepoFile(guideRelative));
    assert(headings.has(githubHeadingSlug(chapter.guide_section)),
      `storyboard chapter ${chapter.id} maps to a missing heading: ${chapter.guide_section}`);
    summary.demoMappings += 1;

    assert.equal(typeof chapter.review?.question, "string",
      `storyboard chapter ${chapter.id} needs a review question`);
    assert(["draft", "owner-review", "ready-for-voice", "published"].includes(chapter.review?.status),
      `storyboard chapter ${chapter.id} has an unsupported review status`);
    assert.equal(typeof chapter.review?.next_gate, "string",
      `storyboard chapter ${chapter.id} needs a next review gate`);
    for (const [artifact, href] of Object.entries(chapter.review?.artifacts || {})) {
      assert.match(href, /^\/assets\/demo\//,
        `storyboard chapter ${chapter.id} review artifact ${artifact} must stay under /assets/demo`);
      assertFile(resolveRepoPath(href.slice(1)),
        `storyboard chapter ${chapter.id} review artifact ${artifact}`);
    }
    assert.equal(Object.keys(chapter.review?.artifacts || {}).length, 5,
      `storyboard chapter ${chapter.id} must expose five review artifacts`);
    summary.demoReviews += 1;
  }

  const chineseReadme = readRepoFile("README.zh-CN.md");
  assert(chineseReadme.includes("(docs/quick-start.zh-CN.md)"), "Chinese README must link quick start");
  assert(chineseReadme.includes("(docs/user-guide.md)"), "Chinese README must link user guide index");
  assert(
    chineseReadme.includes("![从一次用户请求追踪到工具结果、最终回答和原始协议](assets/demo/quickstart-tool-loop.gif)"),
    "Chinese README must keep the reviewed primary demo",
  );

  const englishReadme = readRepoFile("README.md");
  assert(englishReadme.includes("(docs/quick-start.zh-CN.md)"),
    "English README must link the current Chinese quick start while translation is pending");
  assert(englishReadme.includes("(docs/user-guide.md)"),
    "English README must link the current user guide while translation is pending");
  assert(
    englishReadme.includes(
      "![Trace one user request through tool results, the final answer, and the native protocol](assets/demo/quickstart-tool-loop.gif)",
    ),
    "English README must keep the reviewed primary demo",
  );
  for (const fact of [
    "pma openclaw chat",
    "OpenAI Responses",
    "Anthropic Messages",
    "Google GenerateContent",
  ]) {
    assert(englishReadme.includes(fact), `English README is missing current product fact: ${fact}`);
  }

  const packageJson = JSON.parse(readRepoFile("package.json"));
  assert.match(packageJson.engines?.node || "", /^>=24(?:\.0\.0)?$/);
  for (const doc of ["README.md", "README.zh-CN.md", "docs/quick-start.zh-CN.md"]) {
    assert.match(readRepoFile(doc), /Node\.js 24/);
  }

  const helpResult = spawnSync(process.execPath, ["bin/peekmyagent.mjs", "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(helpResult.status, 0, "pma --help must exit successfully");
  const help = helpResult.stdout;
  for (const fact of cliFacts) {
    assert(help.includes(fact.help), "pma --help is missing documented command: " + fact.help);
    for (const doc of fact.docs) {
      const normalizedDoc = normalizeCommandText(readRepoFile(doc));
      assert(
        normalizedDoc.includes(normalizeCommandText(fact.help)),
        doc + " is missing CLI fact from current help: " + fact.help,
      );
    }
  }

  if (log) {
    console.log(
      "documentation consistency audit passed: "
        + summary.documents + " documents, "
        + summary.links + " local links, "
        + summary.anchors + " anchors, "
        + summary.chapters + " chapters, "
        + summary.cliFacts + " CLI facts, "
        + summary.demoMappings + " demo mappings, "
        + summary.demoReviews + " review contracts",
    );
  }
  return summary;
}

export function buildDocumentationImpact(changedFiles) {
  const normalizedFiles = [...new Set(changedFiles.map(normalizeRepoRelative).filter(Boolean))].sort();
  const impacts = impactRules
    .filter((rule) => normalizedFiles.some((file) => rule.patterns.some((pattern) => pattern.test(file))))
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      changed_files: normalizedFiles.filter((file) => rule.patterns.some((pattern) => pattern.test(file))),
      required_docs: rule.docs,
      required_demos: rule.demos,
    }));
  return { changed_files: normalizedFiles, impacts };
}

export function buildDocumentationHandoff(impact, { base = null, target = null } = {}) {
  const requiredDocs = [...new Set(impact.impacts.flatMap((item) => item.required_docs))].sort();
  const requiredDemos = [...new Set(impact.impacts.flatMap((item) => item.required_demos))].sort();
  return {
    target_sha: resolveGitRevision(target || "HEAD"),
    base_sha: base ? resolveGitRevision(base) : null,
    working_tree_dirty: gitOutput(["status", "--porcelain"]).trim().length > 0,
    requires_documentation_review: impact.impacts.length > 0,
    changed_files: impact.changed_files,
    impact_ids: impact.impacts.map((item) => item.id),
    required_docs: requiredDocs,
    required_demos: requiredDemos,
    validation_commands: [
      "node scripts/documentation-consistency-audit.mjs",
      "node scripts/demo-production-audit.mjs",
      "node scripts/governance-smoke.mjs",
      "node scripts/markdown-safety-smoke.mjs",
      "git diff --check",
    ],
    sensitive_data_restrictions: [
      "Do not use real captures, prompts, API keys, user source code, or private local paths.",
      "Re-record Viewer material only with a deterministic or explicitly approved non-sensitive Source.",
      "Treat roadmap items as planned behavior until current repository and UI evidence prove otherwise.",
    ],
  };
}

function auditMarkdownLinks(markdownPath) {
  const markdown = fs.readFileSync(markdownPath, "utf8");
  const result = { links: 0, anchors: 0 };
  const linkPattern = /!?\[[^\]]*\]\((<[^>]+>|[^)]+)\)/g;

  for (const match of markdown.matchAll(linkPattern)) {
    const target = extractTarget(match[1]);
    if (!target || isExternalTarget(target)) continue;
    result.links += 1;

    const hashIndex = target.indexOf("#");
    const rawPath = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const rawAnchor = hashIndex >= 0 ? target.slice(hashIndex + 1) : "";
    const decodedPath = safeDecode(rawPath);
    const targetPath = decodedPath
      ? path.resolve(path.dirname(markdownPath), decodedPath)
      : markdownPath;
    assertFile(targetPath, "link from " + repoRelative(markdownPath));

    if (rawAnchor && path.extname(targetPath).toLowerCase() === ".md") {
      result.anchors += 1;
      const anchor = safeDecode(rawAnchor).toLowerCase();
      const anchors = collectHeadingAnchors(fs.readFileSync(targetPath, "utf8"));
      assert(
        anchors.has(anchor),
        repoRelative(markdownPath) + " links missing anchor #" + anchor + " in " + repoRelative(targetPath),
      );
    }
  }
  return result;
}

function collectHeadingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = githubHeadingSlug(match[2]);
    if (!base) continue;
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : base + "-" + count);
  }
  return anchors;
}

function githubHeadingSlug(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractTarget(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end >= 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const titleIndex = trimmed.search(/\s+["']/);
  return titleIndex >= 0 ? trimmed.slice(0, titleIndex) : trimmed;
}

function isExternalTarget(target) {
  return /^(?:https?:|mailto:|data:|javascript:)/i.test(target);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeCommandText(value) {
  return value.replace(/\\\s*\r?\n\s*/g, " ").replace(/\s+/g, " ");
}

function assertFile(absolutePath, label) {
  assert(
    fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile(),
    label + " does not exist: " + repoRelative(absolutePath),
  );
}

function readRepoFile(relativePath) {
  return fs.readFileSync(resolveRepoPath(relativePath), "utf8");
}

function resolveRepoPath(relativePath) {
  return path.resolve(root, relativePath);
}

function repoRelative(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function normalizeRepoRelative(file) {
  if (!file) return "";
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  const relative = repoRelative(absolute);
  return relative.startsWith("../") ? "" : relative;
}

function parseArguments(argv) {
  const options = { changedFiles: [], base: null, target: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--changed-file") {
      options.changedFiles.push(readOptionValue(argv, ++index, argument));
    } else if (argument === "--base") {
      options.base = readOptionValue(argv, ++index, argument);
    } else if (argument === "--target") {
      options.target = readOptionValue(argv, ++index, argument);
    } else {
      throw new Error("unknown argument: " + argument);
    }
  }
  return options;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function changedFilesFromBase(base, target = null) {
  const revision = target ? `${base}...${target}` : base;
  const result = spawnSync("git", ["diff", "--name-only", revision, "--"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "git diff failed for documentation impact range " + revision);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function resolveGitRevision(revision) {
  return gitOutput(["rev-parse", revision]).trim();
}

function gitOutput(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ${arguments_.join(" ")} failed`);
  return result.stdout;
}

function printImpact(impact) {
  if (impact.impacts.length === 0) {
    console.log("documentation impact: no mapped user-documentation boundary changed");
    return;
  }
  console.log("documentation impact report:");
  for (const item of impact.impacts) {
    console.log("- " + item.label + " [" + item.id + "]");
    console.log("  changed: " + item.changed_files.join(", "));
    console.log("  docs: " + item.required_docs.join(", "));
    console.log("  demos: " + item.required_demos.join(", "));
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.target && !options.base) {
    throw new Error("--target requires --base");
  }
  const summary = runDocumentationConsistencyAudit({ log: !options.json });
  const changedFiles = [
    ...options.changedFiles,
    ...(options.base ? changedFilesFromBase(options.base, options.target) : []),
  ];
  const impact = buildDocumentationImpact(changedFiles);
  const handoff = buildDocumentationHandoff(impact, {
    base: options.base,
    target: options.target,
  });
  if (options.json) {
    process.stdout.write(JSON.stringify({ summary, handoff, impact }, null, 2) + "\n");
  } else if (changedFiles.length > 0) {
    printImpact(impact);
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
