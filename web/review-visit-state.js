function orderedVisits(map) {
  return [...(map?.chapters || [])]
    .sort((left, right) => (left.reviewOrder || 0) - (right.reviewOrder || 0))
    .flatMap((chapter) => chapter.visits || []);
}

function unitSignature(visit) {
  return [...(visit?.changeUnitIds || [])].sort().join("\u0000");
}

export function nextReviewVisit(map, reviewedVisits, activeVisitId, direction = 1) {
  const visits = orderedVisits(map);
  if (visits.length === 0) return null;
  const start = Math.max(-1, visits.findIndex((visit) => visit.id === activeVisitId));
  for (let offset = 1; offset <= visits.length; offset += 1) {
    const index = (start + offset * (direction < 0 ? -1 : 1) + visits.length * 2) % visits.length;
    const visit = visits[index];
    if (visit && reviewedVisits?.[visit.id] !== true) return visit;
  }
  return visits[start < 0 ? 0 : start] || null;
}

export function completeVisit(reviewedVisits, visitId) {
  return { ...(reviewedVisits || {}), [visitId]: true };
}

export function isFileReviewComplete(map, reviewedVisits, fileId) {
  const visits = orderedVisits(map).filter((visit) => visit.fileId === fileId);
  return visits.length > 0 && visits.every((visit) => reviewedVisits?.[visit.id] === true);
}

export function reconcileReviewMapState(previousMap, nextMap, state) {
  const previousVisits = orderedVisits(previousMap);
  const nextVisits = orderedVisits(nextMap);
  const nextBySignature = new Map(nextVisits.map((visit) => [unitSignature(visit), visit]));
  const reviewedVisits = {};
  for (const visit of previousVisits) {
    if (state.reviewedVisits?.[visit.id] !== true) continue;
    const replacement = nextBySignature.get(unitSignature(visit));
    if (replacement) reviewedVisits[replacement.id] = true;
  }
  const activePrevious = previousVisits.find((visit) => visit.id === state.activeVisitId);
  const activeReplacement = activePrevious == null ? null : nextBySignature.get(unitSignature(activePrevious)) || null;
  return {
    ...state,
    reviewedVisits,
    activeVisitId: activeReplacement?.id || null,
    activeFileId: nextVisits.some((visit) => visit.fileId === state.activeFileId) ? state.activeFileId : activeReplacement?.fileId || null,
  };
}
