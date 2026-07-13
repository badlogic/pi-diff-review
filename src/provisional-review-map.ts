import type {
  ReviewChangeUnit,
  ReviewCommit,
  ReviewMap,
  ReviewVisitRole,
  SemanticReviewChapter,
} from "./types.js";

export interface CompileProvisionalReviewMapOptions {
  sourceFingerprint: string;
  units: ReviewChangeUnit[];
  commits: ReviewCommit[];
}

interface ProvisionalArea {
  id: string;
  title: string;
  tokens: RegExp;
  role: ReviewVisitRole;
  objective: string;
}

const AREAS: ProvisionalArea[] = [
  { id: "contracts", title: "Contracts and public boundaries", tokens: /contract|schema|protocol|event.?bus|interface/, role: "contract", objective: "Establish the changed contracts and invariants before their implementations." },
  { id: "runtime", title: "Runtime and resource ownership", tokens: /runtime|session|resource|ownership|lifecycle/, role: "implementation", objective: "Trace runtime ownership, execution, and cleanup behavior." },
  { id: "graph", title: "Graph and turn integration", tokens: /langgraph|graph|turn.?trac|adapter/, role: "integration", objective: "Follow the changed graph and turn integration flow." },
  { id: "execution", title: "Tool and search execution", tokens: /placard|web.?search|tool.?exec|search/, role: "implementation", objective: "Review tool execution behavior and its external boundaries." },
  { id: "routing", title: "Routing and replaced paths", tokens: /route|routing|continuation|retir|remove|delete/, role: "removed-path", objective: "Verify routing changes and behavior that is removed or replaced." },
  { id: "worker", title: "Worker shutdown and cancellation", tokens: /worker|shutdown|cancel|termination/, role: "implementation", objective: "Verify worker lifecycle, cancellation, and terminal cleanup paths." },
  { id: "verification", title: "Cross-cutting regression evidence", tokens: /integration.?test|end.?to.?end|regression|fixture/, role: "verification", objective: "Check cross-cutting evidence that does not belong to one implementation flow." },
  { id: "supporting", title: "Supporting documentation and tooling", tokens: /(^|\/)docs?\/|readme|script|example|changelog/, role: "reference", objective: "Review supporting material after executable behavior." },
];

function changedLineCount(unit: ReviewChangeUnit): number {
  return unit.ranges.reduce((total, range) => total + range.endLine - range.startLine + 1, 0);
}

function evidenceText(unit: ReviewChangeUnit, commits: Map<string, ReviewCommit>): string {
  return [
    unit.path,
    unit.symbol ?? "",
    ...unit.commitIds.map((id) => commits.get(id)?.subject ?? ""),
  ].join(" ").toLowerCase();
}

function classify(unit: ReviewChangeUnit, commits: Map<string, ReviewCommit>): ProvisionalArea {
  const evidence = evidenceText(unit, commits);
  return AREAS.find((area) => area.tokens.test(evidence)) ?? {
    id: "supporting-unclassified",
    title: "Supporting or unclassified changes",
    tokens: /$^/,
    role: "reference",
    objective: "Account for remaining changed lines while the semantic review plan is prepared.",
  };
}

function visitRole(area: ProvisionalArea, path: string): ReviewVisitRole {
  return /(^|\/)(test|tests|spec|specs)(\/|_)|[._](test|spec)\./i.test(path) ? "verification" : area.role;
}

function compileChapter(area: ProvisionalArea, units: ReviewChangeUnit[], reviewOrder: number): SemanticReviewChapter {
  const byFile = new Map<string, ReviewChangeUnit[]>();
  for (const unit of units) {
    const existing = byFile.get(unit.fileId) ?? [];
    existing.push(unit);
    byFile.set(unit.fileId, existing);
  }
  const visits = [...byFile.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([fileId, fileUnits], index) => ({
    id: `visit-${area.id}-${index + 1}`,
    fileId,
    changeUnitIds: fileUnits.map((unit) => unit.id).sort(),
    role: visitRole(area, fileUnits[0]?.path ?? fileId),
    reason: visitRole(area, fileUnits[0]?.path ?? fileId) === "verification"
      ? "Read this evidence with the behavior it exercises."
      : area.objective,
    focus: fileUnits.map((unit) => unit.symbol).filter((symbol): symbol is string => symbol != null),
  }));
  const ranges = units.flatMap((unit) => unit.ranges);
  const reviewWeight = ranges.reduce((total, range) => total + range.endLine - range.startLine + 1, 0);
  const verificationVisits = visits.filter((visit) => visit.role === "verification");
  return {
    id: `provisional-${area.id}`,
    title: area.title,
    objective: area.objective,
    whyItMatters: "This provisional grouping keeps related changed behavior together while semantic analysis runs.",
    summary: area.objective,
    reviewOrder,
    reviewWeight: Math.max(1, reviewWeight),
    priority: reviewOrder === 1 ? "review-first" : area.role === "reference" ? "reference" : "standard",
    priorityReason: reviewOrder === 1 ? "Start with the earliest contract or execution boundary detected from the diff." : "Order is derived from stable change-flow signals.",
    attentionTags: [],
    dependsOn: [],
    reviewQuestions: ["What behavior changes here, and which callers or evidence confirm the new contract?"],
    changeFlow: visits.map((visit) => visit.role),
    visits,
    testEvidence: verificationVisits.length === 0 ? [] : [{
      visitIds: verificationVisits.map((visit) => visit.id),
      proves: ["The paired tests exercise this provisional change area."],
      doesNotProve: ["Semantic analysis has not yet assessed missing edge cases."],
    }],
    exitCriteria: ["Every visit in this area has been reviewed."],
    fileIds: [...byFile.keys()].sort(),
    ranges,
    findingIds: [],
  };
}

export function compileProvisionalReviewMap(options: CompileProvisionalReviewMapOptions): ReviewMap {
  const commits = new Map(options.commits.map((commit) => [commit.sha, commit]));
  const sortedUnits = [...options.units].sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
  const grouped = new Map<string, { area: ProvisionalArea; units: ReviewChangeUnit[] }>();
  for (const unit of sortedUnits) {
    const area = classify(unit, commits);
    const group = grouped.get(area.id) ?? { area, units: [] };
    group.units.push(unit);
    grouped.set(area.id, group);
  }
  const areaOrder = new Map(AREAS.map((area, index) => [area.id, index]));
  const chapters = [...grouped.values()]
    .sort((left, right) => (areaOrder.get(left.area.id) ?? Number.MAX_SAFE_INTEGER) - (areaOrder.get(right.area.id) ?? Number.MAX_SAFE_INTEGER))
    .map((group, index) => compileChapter(group.area, group.units, index + 1));
  const originalLineCount = sortedUnits.flatMap((unit) => unit.ranges).filter((range) => range.side === "original")
    .reduce((total, range) => total + range.endLine - range.startLine + 1, 0);
  const modifiedLineCount = sortedUnits.flatMap((unit) => unit.ranges).filter((range) => range.side === "modified")
    .reduce((total, range) => total + range.endLine - range.startLine + 1, 0);

  return {
    version: 2,
    status: "provisional",
    sourceFingerprint: options.sourceFingerprint,
    strategyVersion: "provisional-map-v1",
    story: {
      intent: "Preparing a semantic review journey from the changed behavior.",
      behaviorBefore: "Semantic before-state analysis is still running.",
      behaviorAfter: "Semantic after-state analysis is still running.",
      primaryFlows: chapters.map((chapter) => chapter.title),
      removedOrReplacedBehavior: [],
    },
    changeUnits: sortedUnits,
    chapters,
    coverage: {
      fileCount: new Set(sortedUnits.map((unit) => unit.fileId)).size,
      originalLineCount,
      modifiedLineCount,
      unmappedFileCount: 0,
      unmappedOriginalLineCount: 0,
      unmappedModifiedLineCount: 0,
      overlappingOriginalLineCount: 0,
      overlappingModifiedLineCount: 0,
    },
    diagnostics: ["Preparing review plan from deterministic diff and commit signals."],
  };
}
