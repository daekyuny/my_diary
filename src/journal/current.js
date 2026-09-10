// The current app keeps one saved value per diary; the legacy app retains its old model.
export function entryGroups(revisions) {
  const latest = new Map();
  for (const r of revisions) {
    const previous = latest.get(r.entry.id);
    if (!previous || `${r.savedAt}:${r.id}` > `${previous.savedAt}:${previous.id}`)
      latest.set(r.entry.id, r);
  }
  return [...latest.values()].map((r) => ({ latest: r, heads: [r] }));
}
export function expired(entry, days, now = Date.now()) {
  return (
    Boolean(entry.deletedAt) &&
    Number.isFinite(Date.parse(entry.deletedAt)) &&
    Date.parse(entry.deletedAt) <= now - days * 86400000
  );
}
