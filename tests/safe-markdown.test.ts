import assert from "node:assert/strict";
import test from "node:test";
import { renderSafeMarkdown, safeExternalUrl } from "../web/safe-markdown.js";

test("renders a focused Markdown subset", () => {
  const html = renderSafeMarkdown("# Title\n\n- one\n- two\n\nUse `code` and **care**.\n\n```\n<x>\n```");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>care<\/strong>/);
  assert.match(html, /&lt;x&gt;/);
});

test("escapes raw HTML and rejects unsafe links", () => {
  const html = renderSafeMarkdown("<script>alert(1)</script> [bad](javascript:alert(1)) [good](https://github.com/o/r)");
  assert.doesNotMatch(html, /<script|javascript:/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-external-url="https:\/\/github\.com\/o\/r"/);
  assert.equal(safeExternalUrl("http://github.com/o/r"), null);
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
});
