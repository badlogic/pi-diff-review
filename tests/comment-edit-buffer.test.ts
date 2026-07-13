import assert from "node:assert/strict";
import test from "node:test";
import { createCommentEditBuffer } from "../web/comment-edit-buffer.js";

function comment(body: string) {
  return { id: "comment-1", body };
}

test("live edit text is serialized without mutating the saved read value", () => {
  const buffer = createCommentEditBuffer();
  const item = comment("original text");

  buffer.begin(item);
  buffer.update(item, "text still being typed");

  assert.equal(item.body, "original text");
  assert.equal(buffer.bodyFor(item), "text still being typed");
  assert.deepEqual(buffer.snapshot([item]), [{ id: "comment-1", body: "text still being typed" }]);
});

test("cancel restores an existing comment and removes a new empty comment", () => {
  const buffer = createCommentEditBuffer();
  const existing = comment("keep me");
  buffer.begin(existing);
  buffer.update(existing, "discard me");

  assert.deepEqual(buffer.cancel(existing), { deleteComment: false });
  assert.equal(existing.body, "keep me");
  assert.equal(buffer.bodyFor(existing), "keep me");

  const added = { id: "new-comment", body: "" };
  buffer.begin(added);
  buffer.update(added, "unfinished draft");
  assert.deepEqual(buffer.cancel(added), { deleteComment: true });
});

test("save commits the trimmed draft and clears the edit buffer", () => {
  const buffer = createCommentEditBuffer();
  const item = comment("before");
  buffer.begin(item);
  buffer.update(item, "  after  ");

  assert.deepEqual(buffer.save(item), { deleteComment: false });
  assert.equal(item.body, "after");
  assert.equal(buffer.bodyFor(item), "after");
});
