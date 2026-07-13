export function isFileCanvasActive(activeCanvas, activeFileId, fileId) {
  return activeCanvas === "file" && activeFileId === fileId;
}

function chapterVisits(chapter) {
  return Array.isArray(chapter?.visits) ? chapter.visits : [];
}

function hasUnreviewedVisit(chapter, reviewedVisits) {
  return chapterVisits(chapter).some((visit) => reviewedVisits?.[visit.id] !== true);
}

export function firstUnreviewedVisitInChapter(chapter, reviewedVisits) {
  return chapterVisits(chapter).find((visit) => reviewedVisits?.[visit.id] !== true) || null;
}

export function nextGuidedReviewDestination(chapters, reviewedVisits, activeVisitId) {
  const orderedChapters = Array.isArray(chapters) ? chapters : [];
  const currentChapterIndex = orderedChapters.findIndex((chapter) =>
    chapterVisits(chapter).some((visit) => visit.id === activeVisitId)
  );
  if (currentChapterIndex < 0) {
    return { kind: "stay", reason: "active-visit-not-found" };
  }

  const currentChapter = orderedChapters[currentChapterIndex];
  const nextVisit = chapterVisits(currentChapter).find((visit) =>
    visit.id !== activeVisitId && reviewedVisits?.[visit.id] !== true
  );
  if (nextVisit) {
    return {
      kind: "visit",
      chapterId: currentChapter.id,
      visitId: nextVisit.id,
      fileId: nextVisit.fileId,
    };
  }

  const laterChapter = orderedChapters
    .slice(currentChapterIndex + 1)
    .find((chapter) => hasUnreviewedVisit(chapter, reviewedVisits));
  if (laterChapter) return { kind: "chapter", chapterId: laterChapter.id };

  const earlierChapter = orderedChapters
    .slice(0, currentChapterIndex)
    .find((chapter) => hasUnreviewedVisit(chapter, reviewedVisits));
  if (earlierChapter) return { kind: "chapter", chapterId: earlierChapter.id };

  return { kind: "ai-review" };
}
