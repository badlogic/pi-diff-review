import assert from "node:assert/strict";
import test from "node:test";
import { createFallbackAnalysis, parseReviewAnalysisJson } from "../src/analysis.js";
import type { ReviewDataset } from "../src/sources/types.js";

function dataset(paths: string[], analysisFileIds = paths): ReviewDataset {
  return {
    repoRoot: "/repo",
    workingRoot: "/repo",
    commits: [],
    analysisFileIds,
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot: "/repo",
      workingRoot: "/repo",
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
    files: paths.map((path) => ({
      id: path,
      path,
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      gitDiff: {
        status: "modified",
        oldPath: path,
        newPath: path,
        displayPath: path,
        hasOriginal: true,
        hasModified: true,
        commentableOriginalLines: [{ start: 1, end: 1 }],
        commentableModifiedLines: [{ start: 1, end: 2 }],
      },
      lastCommit: null,
      commitComparisons: {},
    })),
  };
}

function validModelAnalysis() {
  return {
    chapters: [{
      id: "api-surface",
      title: "API surface",
      summary: "Review API behavior before approval.",
      priority: "standard",
      attentionTags: ["API"],
      fileIds: ["src/app/api/qa_api.py"],
      findingIds: ["missing-validation"],
    }],
    findings: [{
      id: "missing-validation",
      kind: "bug",
      severity: "medium",
      confidence: "high",
      title: "Validate request payload",
      explanation: "Invalid request payloads can reach the service layer.",
      suggestedComment: "Should this validate the request payload before calling the service?",
      locations: [{
        fileId: "src/app/api/qa_api.py",
        path: "src/app/api/qa_api.py",
        side: "modified",
        line: 12,
      }],
      status: "new",
    }],
    approvalPacket: {
      summary: "Review the API changes.",
      reviewedChapters: ["api-surface"],
      acceptedRisks: [],
      unresolvedFindings: ["missing-validation"],
      suggestedVerdict: "comment",
      body: "Please review the API behavior.",
    },
  };
}

test("fallback groups migrations, services, api, and tests", () => {
  const analysis = createFallbackAnalysis(dataset([
    "migrations/versions/abc.py",
    "src/app/api/qa_api.py",
    "src/app/services/qa/store.py",
    "tests/app/api/test_qa_api.py",
  ]), "fallback");

  assert.equal(analysis.status, "fallback");
  assert.deepEqual(analysis.chapters.map((chapter) => chapter.title), [
    "Schema and migrations",
    "API surface",
    "Service behavior",
    "Tests",
  ]);
});

test("fallback ranks review plan independently of file order", () => {
  const analysis = createFallbackAnalysis(dataset([
    "scripts/update_snapshot.py",
    "tests/app/api/test_qa_api.py",
    "src/app/api/qa_api.py",
    "migrations/versions/abc.py",
  ]), "fallback");

  assert.deepEqual(analysis.chapters.map((chapter) => chapter.title), [
    "Schema and migrations",
    "API surface",
    "Tests",
    "Miscellaneous changes",
  ]);
  assert.deepEqual(analysis.chapters.map((chapter) => chapter.reviewOrder), [1, 2, 3, 4]);
  assert.ok(analysis.chapters.every((chapter) => chapter.reviewWeight > 0));
});

test("fallback uses chapter priority and attention tags instead of risk", () => {
  const analysis = createFallbackAnalysis(dataset([
    "migrations/versions/abc.py",
    "tests/app/api/test_qa_api.py",
  ]), "fallback");

  assert.equal(analysis.chapters[0]?.priority, "review-first");
  assert.deepEqual(analysis.chapters[0]?.attentionTags, ["Schema", "Migrations"]);
  assert.equal(analysis.chapters[1]?.priority, "standard");
  assert.deepEqual(analysis.chapters[1]?.attentionTags, ["Tests"]);
});

test("fallback approval packet mentions source label", () => {
  const analysis = createFallbackAnalysis(dataset(["src/app/api/qa_api.py"]), "fallback");

  assert.match(analysis.approvalPacket.body, /Reviewed Local diff/);
});

test("fallback review map only groups focused analysis files", () => {
  const reviewDataset = dataset([
    "src/app/api/qa_api.py",
    ".agent/rules/agent-orchestration-ho.md",
    "src/app/services/qa/store.py",
  ], [
    "src/app/api/qa_api.py",
    "src/app/services/qa/store.py",
  ]);

  const analysis = createFallbackAnalysis(reviewDataset, "fallback");

  assert.deepEqual(analysis.chapters.map((chapter) => chapter.title), [
    "API surface",
    "Service behavior",
  ]);
  assert.equal(analysis.chapters.some((chapter) => chapter.fileIds.includes(".agent/rules/agent-orchestration-ho.md")), false);
  assert.deepEqual(analysis.chapters[0]?.ranges, [
    {
      fileId: "src/app/api/qa_api.py",
      path: "src/app/api/qa_api.py",
      side: "original",
      startLine: 1,
      endLine: 1,
    },
    {
      fileId: "src/app/api/qa_api.py",
      path: "src/app/api/qa_api.py",
      side: "modified",
      startLine: 1,
      endLine: 2,
    },
  ]);
  assert.equal(analysis.coverage.fileCount, 2);
  assert.equal(analysis.coverage.originalLineCount, 2);
  assert.equal(analysis.coverage.modifiedLineCount, 4);
  assert.match(analysis.approvalPacket.summary, /2 reviewable change file\(s\)/);
});

test("parser rejects malformed nested analysis JSON", () => {
  assert.throws(
    () => parseReviewAnalysisJson(JSON.stringify({
      chapters: [{ id: "unsafe-chapter" }],
      findings: [],
      approvalPacket: { body: "Looks ready." },
    })),
    /chapters\[0\]\.title/,
  );
});

test("parser normalizes model supplied finding statuses to new", () => {
  const modelAnalysis = validModelAnalysis();
  modelAnalysis.findings[0].status = "dismissed";

  const analysis = parseReviewAnalysisJson(JSON.stringify(modelAnalysis));

  assert.equal(analysis.findings[0].status, "new");
});

test("parser rejects duplicate chapter ids when a dataset is supplied", () => {
  const modelAnalysis = validModelAnalysis();
  modelAnalysis.chapters.push({
    ...modelAnalysis.chapters[0],
    title: "Duplicate API surface",
    fileIds: [],
    findingIds: [],
  });

  assert.throws(
    () => parseReviewAnalysisJson(JSON.stringify(modelAnalysis), dataset(["src/app/api/qa_api.py"])),
    /chapters\[1\]\.id/,
  );
});

test("parser rejects duplicate finding ids when a dataset is supplied", () => {
  const modelAnalysis = validModelAnalysis();
  modelAnalysis.findings.push({
    ...modelAnalysis.findings[0],
    title: "Duplicate validation finding",
  });

  assert.throws(
    () => parseReviewAnalysisJson(JSON.stringify(modelAnalysis), dataset(["src/app/api/qa_api.py"])),
    /findings\[1\]\.id/,
  );
});

test("parser appends unmapped diff chapter for omitted focused files", () => {
  const modelAnalysis = validModelAnalysis();

  const analysis = parseReviewAnalysisJson(JSON.stringify(modelAnalysis), dataset([
    "src/app/api/qa_api.py",
    "src/app/services/qa/store.py",
  ]));
  const unmappedChapter = analysis.chapters.at(-1);

  assert.equal(unmappedChapter?.id, "unmapped-diff");
  assert.equal(unmappedChapter?.title, "Unmapped diff");
  assert.deepEqual(unmappedChapter?.fileIds, ["src/app/services/qa/store.py"]);
  assert.deepEqual(unmappedChapter?.ranges, [
    {
      fileId: "src/app/services/qa/store.py",
      path: "src/app/services/qa/store.py",
      side: "original",
      startLine: 1,
      endLine: 1,
    },
    {
      fileId: "src/app/services/qa/store.py",
      path: "src/app/services/qa/store.py",
      side: "modified",
      startLine: 1,
      endLine: 2,
    },
  ]);
  assert.equal(analysis.coverage.fileCount, 2);
  assert.equal(analysis.coverage.unmappedFileCount, 1);
  assert.equal(analysis.coverage.unmappedOriginalLineCount, 1);
  assert.equal(analysis.coverage.unmappedModifiedLineCount, 2);
});

test("parser uses explicit review order and recomputes chapter weights", () => {
  const reviewDataset = dataset([
    "tests/app/api/test_qa_api.py",
    "src/app/api/qa_api.py",
    "migrations/versions/abc.py",
  ]);
  const modelAnalysis = {
    chapters: [
      {
        id: "tests",
        title: "Tests",
        summary: "Review test coverage.",
        reviewOrder: 3,
        priority: "standard",
        attentionTags: ["Tests"],
        fileIds: ["tests/app/api/test_qa_api.py"],
        findingIds: [],
      },
      {
        id: "api-surface",
        title: "API surface",
        summary: "Review API behavior.",
        reviewOrder: 1,
        priority: "review-first",
        attentionTags: ["API"],
        fileIds: ["src/app/api/qa_api.py"],
        findingIds: [],
      },
      {
        id: "schema",
        title: "Schema and migrations",
        summary: "Review migration ordering.",
        reviewOrder: 2,
        priority: "review-first",
        attentionTags: ["Schema"],
        fileIds: ["migrations/versions/abc.py"],
        findingIds: [],
      },
    ],
    findings: [],
    approvalPacket: {
      summary: "Review all areas.",
      reviewedChapters: ["tests", "api-surface", "schema"],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "Review all areas.",
    },
  };

  const analysis = parseReviewAnalysisJson(JSON.stringify(modelAnalysis), reviewDataset);

  assert.deepEqual(analysis.chapters.map((chapter) => chapter.id), ["api-surface", "schema", "tests"]);
  assert.deepEqual(analysis.chapters.map((chapter) => chapter.reviewOrder), [1, 2, 3]);
  assert.ok((analysis.chapters[0]?.reviewWeight ?? 0) > (analysis.chapters[2]?.reviewWeight ?? 0));
});

test("parser allows one file to be split across chapter ranges", () => {
  const path = "src/app/services/qa/large_service.py";
  const reviewDataset = dataset([path]);
  const file = reviewDataset.files[0];
  assert.ok(file?.gitDiff);
  file.gitDiff.commentableOriginalLines = [];
  file.gitDiff.commentableModifiedLines = [{ start: 1, end: 6 }];

  const modelAnalysis = {
    chapters: [
      {
        id: "source-resolution",
        title: "Source resolution",
        summary: "Review source lookup behavior.",
        priority: "high-attention",
        attentionTags: ["Services"],
        fileIds: [path],
        ranges: [{ fileId: path, path, side: "modified", startLine: 1, endLine: 2 }],
        findingIds: [],
      },
      {
        id: "storage-contract",
        title: "Storage contract",
        summary: "Review storage behavior.",
        priority: "standard",
        attentionTags: ["Storage"],
        fileIds: [path],
        ranges: [{ fileId: path, path, side: "modified", startLine: 4, endLine: 5 }],
        findingIds: [],
      },
    ],
    findings: [],
    approvalPacket: {
      summary: "Review split service hunks.",
      reviewedChapters: ["source-resolution", "storage-contract"],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "Review split service hunks.",
    },
  };

  const analysis = parseReviewAnalysisJson(JSON.stringify(modelAnalysis), reviewDataset);

  assert.deepEqual(analysis.chapters[0]?.ranges, [{ fileId: path, path, side: "modified", startLine: 1, endLine: 2 }]);
  assert.deepEqual(analysis.chapters[1]?.ranges, [{ fileId: path, path, side: "modified", startLine: 4, endLine: 5 }]);
  assert.deepEqual(analysis.chapters[2]?.ranges, [
    { fileId: path, path, side: "modified", startLine: 3, endLine: 3 },
    { fileId: path, path, side: "modified", startLine: 6, endLine: 6 },
  ]);
  assert.equal(analysis.chapters[2]?.title, "Unmapped diff");
  assert.equal(analysis.coverage.unmappedModifiedLineCount, 2);
});

test("parser does not require non-focused repo files in chapter coverage", () => {
  const modelAnalysis = validModelAnalysis();

  assert.doesNotThrow(
    () => parseReviewAnalysisJson(JSON.stringify(modelAnalysis), dataset([
      "src/app/api/qa_api.py",
      ".agent/rules/agent-orchestration-ho.md",
    ], ["src/app/api/qa_api.py"])),
  );
});

test("parser rejects duplicate chapter file coverage", () => {
  const modelAnalysis = validModelAnalysis();
  modelAnalysis.chapters.push({
    id: "api-follow-up",
    title: "API follow-up",
    summary: "Review API edge cases before approval.",
    priority: "standard",
    attentionTags: ["API"],
    fileIds: ["src/app/api/qa_api.py"],
    findingIds: [],
  });

  assert.throws(
    () => parseReviewAnalysisJson(JSON.stringify(modelAnalysis), dataset(["src/app/api/qa_api.py"])),
    /chapters\[1\]\.fileIds\[0\]/,
  );
});

test("parser rejects invented dataset relationships when a dataset is supplied", () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const cases: Array<{
    name: string;
    mutate: (modelAnalysis: ReturnType<typeof validModelAnalysis>) => void;
    message: RegExp;
  }> = [
    {
      name: "chapter file id",
      mutate: (modelAnalysis) => {
        modelAnalysis.chapters[0].fileIds = ["src/app/api/qa_api.py", "src/app/api/invented.py"];
      },
      message: /chapters\[0\]\.fileIds\[1\]/,
    },
    {
      name: "finding location file id",
      mutate: (modelAnalysis) => {
        modelAnalysis.findings[0].locations[0].fileId = "src/app/api/invented.py";
      },
      message: /findings\[0\]\.locations\[0\]\.fileId/,
    },
    {
      name: "finding location path",
      mutate: (modelAnalysis) => {
        modelAnalysis.findings[0].locations[0].path = "src/app/api/invented.py";
      },
      message: /findings\[0\]\.locations\[0\]\.path/,
    },
    {
      name: "chapter finding id",
      mutate: (modelAnalysis) => {
        modelAnalysis.chapters[0].findingIds = ["missing-validation", "invented-finding"];
      },
      message: /chapters\[0\]\.findingIds\[1\]/,
    },
    {
      name: "approval unresolved finding id",
      mutate: (modelAnalysis) => {
        modelAnalysis.approvalPacket.unresolvedFindings = ["missing-validation", "invented-finding"];
      },
      message: /approvalPacket\.unresolvedFindings\[1\]/,
    },
    {
      name: "approval reviewed chapter id",
      mutate: (modelAnalysis) => {
        modelAnalysis.approvalPacket.reviewedChapters = ["api-surface", "invented-chapter"];
      },
      message: /approvalPacket\.reviewedChapters\[1\]/,
    },
  ];

  for (const { name, mutate, message } of cases) {
    const modelAnalysis = validModelAnalysis();
    mutate(modelAnalysis);

    assert.throws(
      () => parseReviewAnalysisJson(JSON.stringify(modelAnalysis), reviewDataset),
      message,
      name,
    );
  }
});

test("parser rejects non-positive and fractional finding location lines", () => {
  for (const line of [0, -1, 12.5]) {
    const modelAnalysis = validModelAnalysis();
    modelAnalysis.findings[0].locations[0].line = line;

    assert.throws(
      () => parseReviewAnalysisJson(JSON.stringify(modelAnalysis)),
      /findings\[0\]\.locations\[0\]\.line/,
    );
  }
});
