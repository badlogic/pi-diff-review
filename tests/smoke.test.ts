import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

type PackageJson = {
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  name?: string;
  os?: string[];
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

test("package metadata is wired for local development", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageJson;

  assert.equal(packageJson.name, "pi-diff-review-cockpit");
  assert.equal(packageJson.bin?.["pi-diff-review"], "./bin/pi-diff-review.mjs");
  assert.equal(packageJson.engines?.node, ">=22.19.0");
  assert.deepEqual(packageJson.os, ["darwin"]);
  assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-ai"], "^0.80.1");
  assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "^0.80.1");
  assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-tui"], "^0.80.1");
  assert.equal(typeof packageJson.scripts?.cli, "string");
  assert.equal(typeof packageJson.scripts?.check, "string");
  assert.equal(typeof packageJson.scripts?.test, "string");
  assert.equal(packageJson.scripts?.prepare, "npm run build:web");
  assert.equal(packageJson.scripts?.prepack, undefined);
});

test("readme documents direct cli invocation and ref-based PR reviews", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  assert.equal(readme.includes("pi-diff-review pr https://github.com/owner/repo/pull/123"), true);
  assert.equal(readme.includes("isolated review worktree"), false);
  assert.equal(readme.includes("detached cache worktree"), true);
  assert.equal(readme.includes("macOS, Linux, or Windows"), false);
  assert.match(readme, /gpt-5\.6-luna/);
  assert.match(readme, /gpt-5\.6-terra/);
  assert.match(readme, /gpt-5\.6-sol/);
  assert.match(readme, /Pi 0\.80\.6/);
});

test("help and README document explicit ambiguous-intent abandonment and duplicate risk", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const help = execFileSync(process.execPath, [
    fileURLToPath(new URL("../bin/pi-diff-review.mjs", import.meta.url)),
    "--help",
  ], { encoding: "utf8" });

  assert.match(help, /--abandon-ambiguous-publish/);
  assert.match(help, /duplicate GitHub review/i);
  assert.match(readme, /--abandon-ambiguous-publish/);
  assert.match(readme, /duplicate GitHub review/i);
  assert.match(readme, /preserv(?:e|es|ing).*(?:comments|progress)/i);
});

test("right-panel UI avoids duplicated review text and dead progress affordances", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

  assert.equal(appJs.includes("Drafted on diff"), false);
  assert.equal(appJs.includes("Suggested comment</div>"), false);
  assert.equal(appJs.includes("Autosaves locally. Submit review includes non-empty drafts."), false);
  assert.equal(appJs.includes("Draft comments autosave locally"), false);
  assert.equal(appJs.includes("Rerun AI review"), false);
  assert.equal(appJs.includes("h-1.5 overflow-hidden rounded-full"), false);
  assert.equal(appJs.includes("No suggested comment."), false);
  assert.equal(appJs.includes("AI Suggested Draft"), false);
  assert.equal(appJs.includes("Draft ready on diff"), false);
  assert.equal(appJs.includes("Open inline"), false);
  assert.equal(appJs.includes("Remove draft"), false);
  assert.equal(appJs.includes("Apply suggestion"), false);
  assert.equal(appJs.includes("Stage comment"), true);
  assert.equal(appJs.includes("Staged"), true);
  assert.equal(appJs.includes("data-comment-action=\"edit\""), true);
  assert.equal(appJs.includes("data-comment-action=\"save\""), true);
  assert.equal(appJs.includes("data-comment-action=\"cancel\""), true);
  assert.equal(appJs.includes("data-comment-action=\"delete\""), true);
});

test("renderer completes its boot handshake before starting the review app", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const bootHandshake = appJs.indexOf('sendRendererMessage({ type: "renderer-booted" })');
  const appStartup = appJs.indexOf("startReviewApp(bootstrap.data)");

  assert.notEqual(bootHandshake, -1);
  assert.notEqual(appStartup, -1);
  assert.equal(bootHandshake < appStartup, true);
});

test("finding cards focus and pulse the selected inline finding", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/review.css", import.meta.url), "utf8");

  assert.equal(appJs.includes("pendingFindingFocus"), true);
  assert.equal(appJs.includes("openFirstFindingLocation(finding"), true);
  assert.equal(appJs.includes("pulseInlineFinding"), true);
  assert.equal(appJs.includes("data-ai-finding-id"), true);
  assert.equal(appJs.includes("toggleInlineFindingAtLine"), true);
  assert.equal(appJs.includes("toggleInlineFinding({ finding, location })"), true);
  assert.equal(appJs.includes("review-ai-finding-glyph"), true);
  assert.equal(appJs.includes("review-disclosure-expanded"), true);
  assert.equal(appJs.includes("review-disclosure-collapsed"), true);
  assert.equal(appJs.includes("Collapse AI review"), true);
  assert.equal(appJs.includes("Expand AI review"), true);
  assert.equal(appJs.includes('data-action="collapse-finding"'), true);
  assert.equal(appJs.includes("updateFocusedInlineFinding(side, startLine)"), true);
  assert.equal(appJs.includes("filter(({ finding }) => isAiFindingExpanded(finding.id))"), true);
  assert.equal(appJs.includes("moveDiffFocus(1)"), true);
  assert.equal(appJs.includes("aiFindingDisclosureLabel(finding)"), true);
  assert.equal(appJs.includes("getOpenInlineFindingEntriesForFile(file).length"), true);
  assert.equal(appJs.includes("Jump to first inline AI review item in this file"), true);
  assert.equal(css.includes("ai-finding-pulse"), true);
  assert.equal(css.includes("review-ai-finding-glyph"), true);
  assert.equal(css.includes("review-ai-finding-glyph:hover::before"), true);
  assert.equal(css.includes('content: "⌄"'), true);
  assert.equal(css.includes('content: "›"'), true);
  assert.equal(css.includes('content: "✦"'), false);
});

test("review progress is file-first and keyboard friendly", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

  assert.equal(appJs.includes("advanceToNextUnreviewedFile"), true);
  assert.equal(appJs.includes("findNextUnreviewedFile"), true);
  assert.equal(appJs.includes("chapterReviewProgress"), true);
  assert.equal(appJs.includes("treeReviewProgress"), true);
  assert.equal(appJs.includes("F / Space"), true);
  assert.equal(appJs.includes("Shift+F"), true);
  assert.equal(appJs.includes("fileDisplayParts"), true);
  assert.equal(appJs.includes("toolbarButtonClass"), true);
  assert.equal(appJs.includes("reviewed ? \"✓\" : \"□\""), false);
  assert.equal(appJs.includes("line-through opacity-60"), true);
  assert.equal(html.includes("aria-pressed=\"false\""), true);
  assert.equal(html.includes("Mark this file reviewed and advance"), true);
});

test("renderer prefers canonical diffstats over derived comment anchors", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

  assert.match(appJs, /Number\.isSafeInteger\(comparison\.addedLines\)[\s\S]*?comparison\.addedLines/);
  assert.match(appJs, /Number\.isSafeInteger\(comparison\.deletedLines\)[\s\S]*?comparison\.deletedLines/);
});

test("review workspace is consolidated around one sidebar and checkout drawer", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/review.css", import.meta.url), "utf8");

  assert.equal(html.includes("<div class=\"hidden\">\n        <button id=\"tab-review-map-button\""), true);
  assert.equal(html.includes("Fuzzy filter"), false);
  assert.equal(html.includes("placeholder=\"Filter changed files...\""), true);
  assert.equal(html.includes("<div id=\"scope-controls\" class=\"hidden\""), true);
  assert.equal(html.includes(">All files</button>"), false);
  assert.equal(appJs.includes("updateFilterPlaceholder"), true);
  assert.equal(appJs.includes("Filter ${count} changed ${noun}..."), true);
  assert.equal(appJs.includes("restoredSession.currentScope !== \"all-files\" || initialScope === \"all-files\""), true);
  assert.equal(html.includes("review-checkout-drawer"), true);
  assert.equal(appJs.includes("renderFileNavChildren"), false);
  assert.equal(appJs.includes("renderReviewPlanTree"), true);
  assert.equal(appJs.includes("renderReviewGroup"), true);
  assert.equal(appJs.includes("getReviewNavigationGroups"), true);
  assert.equal(appJs.includes("fileNavBadgesHtml"), true);
  assert.equal(appJs.includes("getOpenInlineFindingEntriesForFile(file).length"), true);
  assert.equal(appJs.includes("data-finding-file-id"), true);
  assert.equal(appJs.includes("openFirstVisibleFindingForFile"), true);
  assert.equal(appJs.includes("chapterBriefHtml"), true);
  assert.equal(appJs.includes("mountChapterBrief"), true);
  assert.equal(appJs.includes("data-chapter-open"), true);
  assert.equal(appJs.includes("leading-tight"), true);
  assert.equal(appJs.includes("chapterDisplayTitle(chapter)"), true);
  assert.equal(appJs.includes("renderSideBySide: activeFileShowsDiff() && !shouldRenderUnifiedForFile()"), true);
  assert.equal(appJs.includes("overviewRuler"), true);
  assert.equal(appJs.includes("minimap"), true);
  assert.equal(css.includes("sidebar-scanning-icon"), true);
  assert.equal(css.includes("sidebar-icon-shimmer"), true);
  assert.equal(css.includes("review-scan-pulse"), false);
  assert.equal(appJs.includes("sidebar-scanning-icon"), true);
  assert.equal(html.includes("chapter-brief-container"), true);
  assert.equal(html.includes('id="session-notice"'), true);
  assert.equal(html.includes("chapter-brief-view"), true);
  assert.equal(appJs.includes("openCheckoutDrawer"), true);
  assert.equal(appJs.includes("closeCheckoutDrawer"), true);
  assert.equal(appJs.includes("renderInsightPanel();"), false);
  assert.equal(appJs.includes("Use the Files tab"), false);
});

test("GitHub PR context stays in a temporary drawer and outside local publish state", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/review.css", import.meta.url), "utf8");
  const host = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  assert.equal(html.includes('id="pr-context-drawer"'), true);
  assert.equal(html.includes('id="github-thread-count"'), true);
  assert.equal(appJs.includes("Open PR context"), true);
  assert.equal(appJs.includes('type: "refresh-github-context"'), true);
  assert.equal(appJs.includes("renderGithubThreadZoneDOM"), true);
  assert.equal(appJs.includes("applyPendingGithubThreadFocus"), true);
  assert.equal(host.includes("mergeRendererSessionCheckpoint(sessionSnapshot, message.snapshot)"), true);
  assert.equal(appJs.includes("state.comments.push(thread"), false);
  assert.equal(css.includes("position: fixed"), true);
  assert.equal(css.includes("review-github-thread-glyph"), true);
});

test("inline findings and comment editors expose home-row actions", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/review.css", import.meta.url), "utf8");

  assert.equal(appJs.includes("Stage comment <kbd"), true);
  assert.equal(appJs.includes("Dismiss <kbd"), true);
  assert.equal(appJs.includes("severityAccentColor"), true);
  assert.equal(appJs.includes("stageCurrentFinding"), true);
  assert.equal(appJs.includes("dismissCurrentFinding"), true);
  assert.equal(appJs.includes("Refresh AI analysis"), true);
  assert.equal(appJs.includes("maybeStartAiReview"), true);
  assert.equal(appJs.includes("aiReviewStatusSummary"), true);
  assert.equal(appJs.includes("aiReviewCompleted"), true);
  assert.equal(appJs.includes("AI analysis incomplete"), true);
  assert.equal(appJs.includes("restoredForCurrentDiff"), true);
  assert.equal(appJs.includes("Cmd/Ctrl+Enter"), true);
  assert.equal(appJs.includes("Cmd/Ctrl+R"), true);
  assert.equal(appJs.includes("insertTextareaText(textarea, \"    \")"), true);
  assert.equal(appJs.includes("Save <span"), true);
  assert.equal(appJs.includes("Cancel <span"), true);
  assert.equal(appJs.includes("toggleInlineCommentAtLine"), true);
  assert.equal(appJs.includes("glyphMarginHoverMessage"), true);
  assert.equal(appJs.includes("commentLifecycleState"), true);
  assert.equal(appJs.includes("publish-github-review-result"), true);
  assert.equal(appJs.includes("handlePublishGitHubReviewResult"), true);
  assert.equal(appJs.includes("reviewData.session?.publishWarning"), true);
  assert.equal(appJs.includes("reviewData.session?.recoveryPath"), true);
  assert.equal(appJs.includes("updateSessionNotice"), true);
  assert.equal(appJs.includes("markCommentsPublished"), true);
  assert.equal(appJs.includes('type: "checkpoint-session"'), true);
  assert.equal(appJs.includes("Reopen required"), true);
  assert.equal(appJs.includes("Submitting review to GitHub..."), true);
  assert.equal(appJs.includes("dismissFindingLocation"), true);
  assert.equal(appJs.includes("dismissedFindingLocationKeys"), true);
  assert.equal(appJs.includes("findInlineCommentAtLine(side, line)"), true);
  assert.equal(css.includes("review-comment-glyph-staged-ai"), true);
  assert.equal(css.includes("review-comment-glyph-staged-user"), true);
  assert.equal(css.includes("review-comment-glyph-published"), true);
  assert.equal(css.includes("review-comment-rail-staged-ai"), true);
  assert.equal(css.includes("review-comment-rail-staged-user"), true);
  assert.equal(css.includes("review-comment-line-original"), false);
  assert.equal(css.includes("review-comment-line-modified"), false);
});
