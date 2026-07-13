export function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(value) {
  const pattern = /(`[^`]+`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let html = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    html += escapeHtml(value.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      html += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (match[2] != null && match[3] != null) {
      const url = safeExternalUrl(match[3]);
      html += url == null
        ? escapeHtml(match[2])
        : `<a href="${escapeHtml(url)}" data-external-url="${escapeHtml(url)}">${escapeHtml(match[2])}</a>`;
    } else if (match[4] != null) {
      html += `<strong>${escapeHtml(match[4])}</strong>`;
    } else {
      html += `<em>${escapeHtml(match[5] ?? "")}</em>`;
    }
    cursor = (match.index ?? 0) + token.length;
  }
  return html + escapeHtml(value.slice(cursor));
}

export function renderSafeMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = [];
  let listTag = null;
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) output.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length > 0 && listTag != null) {
      output.push(`<${listTag}>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${listTag}>`);
    }
    list = [];
    listTag = null;
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (code == null) code = [];
      else {
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      }
      continue;
    }
    if (code != null) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (heading != null) {
      flushParagraph();
      flushList();
      output.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
    } else if (unordered != null || ordered != null) {
      flushParagraph();
      const nextListTag = unordered != null ? "ul" : "ol";
      if (listTag != null && listTag !== nextListTag) flushList();
      listTag = nextListTag;
      list.push((unordered ?? ordered)?.[1] ?? "");
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  if (code != null) output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return output.join("\n");
}
