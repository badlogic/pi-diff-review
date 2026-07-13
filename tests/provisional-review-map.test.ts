import assert from "node:assert/strict";
import test from "node:test";
import { compileProvisionalReviewMap } from "../src/provisional-review-map.js";
import type { ReviewChangeUnit, ReviewCommit } from "../src/types.js";

function unit(id: string, path: string, commitIds: string[] = []): ReviewChangeUnit {
  return {
    id,
    fileId: path,
    path,
    status: "modified",
    commitIds,
    ranges: [{ fileId: path, path, side: "modified", startLine: 1, endLine: 3 }],
  };
}

const commits: ReviewCommit[] = [
  { sha: "c1", shortSha: "c1", subject: "add async tool contracts and event bus" },
  { sha: "c2", shortSha: "c2", subject: "move session runtime resource ownership" },
  { sha: "c3", shortSha: "c3", subject: "bridge turn tracing into langgraph" },
  { sha: "c4", shortSha: "c4", subject: "migrate placard and web search execution" },
  { sha: "c5", shortSha: "c5", subject: "remove continuation routes" },
  { sha: "c6", shortSha: "c6", subject: "handle worker shutdown and cancellation" },
];

test("provisional map uses change flows and pairs focused tests with source", () => {
  const units = [
    unit("contracts", "src/tools/contracts.py", ["c1"]),
    unit("contracts-test", "tests/tools/test_contracts.py", ["c1"]),
    unit("runtime", "src/session/runtime.py", ["c2"]),
    unit("runtime-test", "tests/session/test_runtime.py", ["c2"]),
    unit("graph", "src/graph/langgraph_adapter.py", ["c3"]),
    unit("search", "src/tools/placard_search.py", ["c4"]),
    unit("routes", "src/api/continuation_routes.py", ["c5"]),
    unit("worker", "src/worker/shutdown.py", ["c6"]),
    unit("docs", "docs/async-tools.md"),
  ];

  const map = compileProvisionalReviewMap({ sourceFingerprint: "sha256:pr", units, commits });

  assert.equal(map.status, "provisional");
  assert.ok(map.chapters.length >= 6);
  assert.equal(map.chapters.some((chapter) => chapter.title === "Tests" || chapter.title === "Miscellaneous changes"), false);
  const contractChapter = map.chapters.find((chapter) => chapter.visits.some((visit) => visit.changeUnitIds.includes("contracts")));
  assert.deepEqual(contractChapter?.visits.flatMap((visit) => visit.changeUnitIds).sort(), ["contracts", "contracts-test"]);
  assert.deepEqual(
    map.chapters.flatMap((chapter) => chapter.visits.flatMap((visit) => visit.changeUnitIds)).sort(),
    units.map((item) => item.id).sort(),
  );
});

test("provisional map is stable regardless of incoming unit order", () => {
  const units = [
    unit("runtime", "src/session/runtime.py", ["c2"]),
    unit("contracts", "src/tools/contracts.py", ["c1"]),
  ];
  const first = compileProvisionalReviewMap({ sourceFingerprint: "sha256:pr", units, commits });
  const second = compileProvisionalReviewMap({ sourceFingerprint: "sha256:pr", units: [...units].reverse(), commits });
  assert.deepEqual(first, second);
});
