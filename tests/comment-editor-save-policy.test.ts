import assert from "node:assert/strict";
import test from "node:test";
import { createCommentEditorSavePolicy } from "../web/comment-editor-save-policy.js";

test("moving from the textarea to its action controls does not flush before the action", () => {
  let flushes = 0;
  const policy = createCommentEditorSavePolicy(() => { flushes += 1; });

  policy.onBlur({ movingToCommentAction: true });
  assert.equal(flushes, 0);

  policy.onBlur({ movingToCommentAction: false });
  assert.equal(flushes, 1);
});

test("keyboard Save or Cancel suppresses the blur flush once", () => {
  let flushes = 0;
  const policy = createCommentEditorSavePolicy(() => { flushes += 1; });

  policy.beforeAction();
  policy.onBlur({ movingToCommentAction: false });
  assert.equal(flushes, 0);

  policy.onBlur({ movingToCommentAction: false });
  assert.equal(flushes, 1);
});
