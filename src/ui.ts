import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewWindowData } from "./types.js";

interface BuildReviewHtmlOptions {
  bridgeScript?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "..", "web");

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function buildReviewHtml(data: ReviewWindowData, options: BuildReviewHtmlOptions = {}): string {
  const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
  const appJs = readFileSync(join(webDir, "app.js"), "utf8");
  const payload = escapeForInlineScript(JSON.stringify(data));
  const bridge = options.bridgeScript == null ? "" : `${options.bridgeScript}\n`;
  return templateHtml
    .replace("__INLINE_DATA__", payload)
    .replace("__INLINE_JS__", `${bridge}${appJs}`);
}
