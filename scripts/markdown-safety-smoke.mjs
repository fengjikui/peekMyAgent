import assert from "node:assert/strict";
import { renderMarkdownPreview, renderSafeMarkdown } from "../src/viewer/markdown.js";

const cases = [
  {
    name: "raw html is escaped in paragraphs",
    markdown: `hello <img src=x onerror=alert(1)> <script>alert(1)</script>`,
    expected: "&lt;img src=x onerror=alert(1)&gt;",
  },
  {
    name: "inline markdown cannot smuggle tags",
    markdown: `**<svg onload=alert(1)>bold</svg>** and \`<iframe src=x>\``,
    expected: "<strong>&lt;svg onload=alert(1)&gt;bold&lt;/svg&gt;</strong>",
  },
  {
    name: "tables escape cells",
    markdown: `| name | value |\n| --- | --- |\n| <script>alert(1)</script> | javascript:alert(1) |`,
    expected: "&lt;script&gt;alert(1)&lt;/script&gt;",
  },
  {
    name: "fenced code escapes content",
    markdown: "```html\n<img src=x onerror=alert(1)>\n```",
    expected: "&lt;img src=x onerror=alert(1)&gt;",
  },
];

for (const item of cases) {
  const html = renderSafeMarkdown(item.markdown);
  assert.ok(html.includes(item.expected), `${item.name}: expected escaped content`);
  assertAllowedMarkdownHtml(html, item.name);
}

const preview = renderMarkdownPreview("**safe** <script>alert(1)</script>");
assert.match(preview, /^<div class="translation-markdown">/);
assertAllowedMarkdownHtml(preview, "translation preview wrapper");

console.log("markdown-safety smoke passed");

function assertAllowedMarkdownHtml(html, label) {
  const allowedTags = new Set(["p", "br", "ul", "ol", "li", "pre", "code", "hr", "h3", "h4", "h5", "h6", "div", "table", "thead", "tbody", "tr", "th", "td", "strong"]);
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi)) {
    assert.ok(allowedTags.has(match[1].toLowerCase()), `${label}: unexpected tag ${match[0]}`);
    assert.doesNotMatch(match[0], /\s(?:on\w+|href|src|style)\s*=/i, `${label}: unsafe HTML attributes must not be emitted`);
  }
  assert.doesNotMatch(html, /<script\b/i, `${label}: script tag must not be emitted`);
  assert.doesNotMatch(html, /<img\b/i, `${label}: img tag must not be emitted`);
  assert.doesNotMatch(html, /<svg\b/i, `${label}: svg tag must not be emitted`);
  assert.doesNotMatch(html, /<iframe\b/i, `${label}: iframe tag must not be emitted`);
}
