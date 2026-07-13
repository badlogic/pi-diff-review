export function isDisclosureExpanded(collapsedIds, id) {
  return !collapsedIds.has(id);
}

export function collapseDisclosure(collapsedIds, id) {
  collapsedIds.add(id);
}

export function expandDisclosure(collapsedIds, id) {
  collapsedIds.delete(id);
}

export function toggleDisclosure(collapsedIds, id) {
  if (isDisclosureExpanded(collapsedIds, id)) collapseDisclosure(collapsedIds, id);
  else expandDisclosure(collapsedIds, id);
}

