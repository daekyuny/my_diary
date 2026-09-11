// Dates belong to the diary, independent of when an old diary was edited.
export const RECENT_LIMIT = 100;
export function recentIds(revisions, limit = RECENT_LIMIT) {
  return new Set(
    revisions
      .filter((r) => !r.entry.deletedAt)
      .sort(
        (a, b) => b.entry.date.localeCompare(a.entry.date) || a.entry.id.localeCompare(b.entry.id),
      )
      .slice(0, limit)
      .map((r) => r.id),
  );
}
