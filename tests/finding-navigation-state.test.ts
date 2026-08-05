import assert from "node:assert/strict";
import test from "node:test";
import { firstValidFindingLocation } from "../web/finding-navigation-state.js";

test("finding navigation chooses the first valid diff location", () => {
  const finding = {
    locations: [
      { fileId: "missing.ts", side: "modified", line: 3 },
      { fileId: "src/file.ts", side: "file", line: null },
      { fileId: "src/file.ts", side: "modified", line: 0 },
      { fileId: "src/file.ts", side: "original", line: 8 },
      { fileId: "src/file.ts", side: "modified", line: 12 },
    ],
  };

  assert.deepEqual(firstValidFindingLocation(finding, (fileId) => fileId === "src/file.ts"), {
    fileId: "src/file.ts",
    side: "original",
    line: 8,
  });
});

test("finding navigation reports unavailable locations", () => {
  assert.equal(firstValidFindingLocation({ locations: [] }, () => true), null);
  assert.equal(firstValidFindingLocation({ locations: [{ fileId: "src/file.ts", side: "file", line: null }] }, () => true), null);
});
