/**
 * @param {{ locations?: Array<{ fileId?: string, side?: string, line?: number | null }> }} finding
 * @param {(fileId: string) => boolean} fileExists
 */
export function firstValidFindingLocation(finding, fileExists = () => true) {
  const locations = Array.isArray(finding?.locations) ? finding.locations : [];
  return locations.find((location) => (
    typeof location?.fileId === "string"
    && fileExists(location.fileId)
    && (location.side === "original" || location.side === "modified")
    && Number.isInteger(location.line)
    && location.line > 0
  )) || null;
}
