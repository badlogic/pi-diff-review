import assert from "node:assert/strict";
import test from "node:test";
import { parseDiffReviewArgs } from "../src/command.js";

test("parses empty args as local review", () => {
  assert.deepEqual(parseDiffReviewArgs([]), { mode: "local", resetReview: false });
});

test("parses pr url", () => {
  assert.deepEqual(parseDiffReviewArgs(["pr", "https://github.com/headout/magellan/pull/646"]), {
    mode: "github-pr",
    url: "https://github.com/headout/magellan/pull/646",
    resetReview: false,
  });
});

test("parses reset review flag before local review", () => {
  assert.deepEqual(parseDiffReviewArgs(["--reset-review"]), { mode: "local", resetReview: true });
});

test("parses reset review flag before pr source", () => {
  assert.deepEqual(parseDiffReviewArgs(["--reset-review", "pr", "https://github.com/headout/magellan/pull/646"]), {
    mode: "github-pr",
    url: "https://github.com/headout/magellan/pull/646",
    resetReview: true,
  });
});

test("parses reset review alias after pr source", () => {
  assert.deepEqual(parseDiffReviewArgs(["pr", "https://github.com/headout/magellan/pull/646", "--fresh"]), {
    mode: "github-pr",
    url: "https://github.com/headout/magellan/pull/646",
    resetReview: true,
  });
});

test("rejects pr without url", () => {
  assert.throws(() => parseDiffReviewArgs(["pr"]), /Usage: \/diff-review \[--reset-review\]/);
});

test("rejects unknown source", () => {
  assert.throws(() => parseDiffReviewArgs(["branch", "main"]), /Unsupported diff-review source/);
});

test("rejects unknown diff review option", () => {
  assert.throws(() => parseDiffReviewArgs(["--unknown"]), /Unsupported diff-review option "--unknown"/);
});
