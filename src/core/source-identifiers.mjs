export function sourceIdForWatch(watchId) {
  return `stored-${watchId}`;
}

export function watchIdFromSourceId(sourceId) {
  return sourceId?.startsWith("stored-") ? sourceId.slice("stored-".length) : null;
}
