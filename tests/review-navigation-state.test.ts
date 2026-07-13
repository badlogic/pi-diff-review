import assert from "node:assert/strict";
import test from "node:test";
import { isFileCanvasActive } from "../web/review-navigation-state.js";

test("a file is selected only when its diff canvas is active", () => {
  assert.equal(isFileCanvasActive("file", "file-1", "file-1"), true);
  assert.equal(isFileCanvasActive("chapter", "file-1", "file-1"), false);
  assert.equal(isFileCanvasActive("file", "file-2", "file-1"), false);
});

