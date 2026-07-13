import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubThreadDisclosureState,
  locateCurrentThread,
  threadItemsForFilter,
  unresolvedThreadCount,
} from "../web/github-review-context.js";

const thread = { id: "t1", isResolved: false, isOutdated: false, path: "src/a.ts", side: "modified", line: 12, comments: [] };
const context = { reviewedHeadSha: "head", remoteHeadSha: "head", threads: [thread], reviews: [], conversationComments: [] };
const filesByPath = new Map([["src/a.ts", [{ id: "file-1" }]]]);

test("counts and filters only current unresolved threads", () => {
  assert.equal(unresolvedThreadCount({ ...context, threads: [thread, { ...thread, id: "t2", isResolved: true }, { ...thread, id: "t3", isOutdated: true }] }), 1);
  assert.deepEqual(threadItemsForFilter(context, "open").map((entry: { item: { id: string } }) => entry.item.id), ["t1"]);
});

test("locates only an exact current thread in the loaded model", () => {
  assert.deepEqual(locateCurrentThread(thread, { context, filesByPath, originalLineCount: 10, modifiedLineCount: 20 }), { fileId: "file-1", side: "modified", line: 12 });
  assert.equal(locateCurrentThread({ ...thread, isOutdated: true }, { context, filesByPath, originalLineCount: 10, modifiedLineCount: 20 }), null);
  assert.equal(locateCurrentThread(thread, { context: { ...context, remoteHeadSha: "new" }, filesByPath, originalLineCount: 10, modifiedLineCount: 20 }), null);
  assert.equal(locateCurrentThread(thread, { context, filesByPath, originalLineCount: 10, modifiedLineCount: 11 }), null);
  assert.deepEqual(locateCurrentThread({ ...thread, side: "original", line: null, originalLine: 8 }, { context, filesByPath, originalLineCount: 10, modifiedLineCount: 20 }), { fileId: "file-1", side: "original", line: 8 });
  assert.equal(locateCurrentThread(thread, {
    context,
    filesByPath: new Map([["src/a.ts", [{ id: "file-1" }, { id: "file-2" }]]]),
    originalLineCount: 10,
    modifiedLineCount: 20,
  }), null);
});

test("thread disclosures start expanded and collapse independently", () => {
  const state = createGitHubThreadDisclosureState();
  assert.equal(state.isExpanded("a"), true);
  state.collapse("a");
  assert.equal(state.isExpanded("a"), false);
  assert.equal(state.isExpanded("b"), true);
  state.expand("a");
  assert.equal(state.isExpanded("a"), true);
});

test("multiple threads in one file retain independent identities and disclosure", () => {
  const second = { ...thread, id: "t2", line: 18 };
  const state = createGitHubThreadDisclosureState();

  assert.deepEqual(
    threadItemsForFilter({ ...context, threads: [thread, second] }, "open").map((entry: { item: { id: string } }) => entry.item.id),
    ["t1", "t2"],
  );
  state.collapse("t1");
  assert.equal(state.isExpanded("t1"), false);
  assert.equal(state.isExpanded("t2"), true);
});
