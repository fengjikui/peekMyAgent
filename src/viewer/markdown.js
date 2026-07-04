export function renderMarkdownPreview(text) {
  return `<div class="translation-markdown">${renderSafeMarkdown(text)}</div>`;
}

export function renderSafeMarkdown(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let fence = null;
  let code = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map((line) => renderInlineMarkdown(line.trim())).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushCode = () => {
    if (!fence) return;
    html.push(`<pre class="markdown-code"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    fence = null;
    code = [];
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^(\s*)(```|~~~)/);
    if (fence) {
      if (fenceMatch) {
        flushCode();
      } else {
        code.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushBlocks();
      fence = fenceMatch[2];
      code = [];
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushBlocks();
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushBlocks();
      html.push("<hr>");
      continue;
    }
    if (isMarkdownTableStart(lines, index)) {
      flushBlocks();
      const table = parseMarkdownTable(lines, index);
      html.push(table.html);
      index = table.nextIndex - 1;
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const level = Math.min(4, heading[1].length + 2);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (!list || list.type !== "ul") flushList();
      if (!list) list = { type: "ul", items: [] };
      list.items.push(unordered[1].trim());
      continue;
    }
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (!list || list.type !== "ol") flushList();
      if (!list) list = { type: "ol", items: [] };
      list.items.push(ordered[1].trim());
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  flushCode();
  flushBlocks();
  return html.join("") || "<p></p>";
}

function isMarkdownTableStart(lines, index) {
  return Boolean(lines[index]?.includes("|") && isMarkdownTableSeparator(lines[index + 1] || ""));
}

function isMarkdownTableSeparator(line) {
  const cells = parseMarkdownTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseMarkdownTable(lines, startIndex) {
  const headers = parseMarkdownTableCells(lines[startIndex]);
  const alignments = parseMarkdownTableCells(lines[startIndex + 1]).map((cell) => {
    const trimmed = cell.trim();
    if (/^:-+:$/.test(trimmed)) return "center";
    if (/^-+:$/.test(trimmed)) return "right";
    return "left";
  });
  const rows = [];
  let index = startIndex + 2;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || !line.includes("|")) break;
    rows.push(normalizeMarkdownTableRow(parseMarkdownTableCells(line), headers.length));
    index += 1;
  }
  const safeHeaders = normalizeMarkdownTableRow(headers, headers.length);
  const headerHtml = safeHeaders
    .map((cell, cellIndex) => `<th class="${markdownTableAlignClass(alignments[cellIndex])}">${renderInlineMarkdown(cell)}</th>`)
    .join("");
  const rowsHtml = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, cellIndex) => `<td class="${markdownTableAlignClass(alignments[cellIndex])}">${renderInlineMarkdown(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return {
    html: `<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`,
    nextIndex: index,
  };
}

function parseMarkdownTableCells(line) {
  const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
  if (!trimmed.includes("|")) return [];
  return trimmed.split("|").map((cell) => cell.trim());
}

function normalizeMarkdownTableRow(cells, width) {
  return Array.from({ length: width }, (_, index) => cells[index] || "");
}

function markdownTableAlignClass(alignment) {
  return alignment === "center" ? "align-center" : alignment === "right" ? "align-right" : "align-left";
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
