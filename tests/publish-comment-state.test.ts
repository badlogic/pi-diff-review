import assert from "node:assert/strict";
import test from "node:test";
import { applyAuthoritativePublishedCommentState } from "../web/publish-comment-state.js";

test("ordinary success applies the authoritative submitted object and preserves unrelated drafts", () => {
  const current = [{ id: "comment-1", body: "old body" }, { id: "other", body: "untouched" }];
  const authoritative = [{
    id: "comment-1",
    body: "live draft sent to GitHub",
    status: "published",
    published: true,
    publishedAt: "2026-07-10T00:00:00.000Z",
    githubReviewId: 1234,
  }];

  assert.deepEqual(applyAuthoritativePublishedCommentState(current, authoritative), [
    authoritative[0],
    { id: "other", body: "untouched" },
  ]);
});
