import assert from "node:assert/strict";
import test from "node:test";
import { fileLoadView, isCurrentFileReply } from "../web/file-load-state.js";

test("loading and failed files use a panel instead of Monaco contents", () => {
  assert.deepEqual(fileLoadView({ path: "src/fast.ts", requestId: "request:1" }), {
    kind: "loading",
    title: "Loading src/fast.ts",
    message: "Fetching both sides of the diff.",
  });
  assert.deepEqual(fileLoadView({ path: "src/failed.ts", error: "Permission denied" }), {
    kind: "error",
    title: "Could not load src/failed.ts",
    message: "Permission denied",
  });
});

test("loaded files expose only real contents to Monaco", () => {
  const contents = { originalContent: "before\n", modifiedContent: "after\n" };
  assert.deepEqual(fileLoadView({ path: "src/ready.ts", contents }), {
    kind: "ready",
    contents,
  });
});

test("stale file replies cannot replace a newer request", () => {
  assert.equal(isCurrentFileReply("request:2", "request:2"), true);
  assert.equal(isCurrentFileReply("request:2", "request:1"), false);
  assert.equal(isCurrentFileReply(undefined, "request:1"), false);
});
