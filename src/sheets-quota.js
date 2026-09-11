// Keep headroom below Sheets' 60 requests/minute/user for both quota buckets.
export function createSheetsQuota({
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  notify = () => {},
} = {}) {
  const buckets = { read: [], write: [] };
  let queue = Promise.resolve();
  async function reserve(method) {
    const bucket = buckets[method === 'GET' ? 'read' : 'write'];
    while (true) {
      while (bucket.length && bucket[0] <= now() - 61000) bucket.shift();
      if (bucket.length < 45) {
        bucket.push(now());
        return;
      }
      const delay = bucket[0] + 61000 - now();
      notify(delay);
      await sleep(delay);
    }
  }
  return {
    reserve(method = 'GET') {
      const work = queue.then(() => reserve(method));
      queue = work.catch(() => {});
      return work;
    },
    async retry(response, attempt) {
      if (response.status !== 429 || attempt >= 6) return false;
      const header = response.headers.get('Retry-After');
      const requested = header
        ? /^\d+$/.test(header)
          ? Number(header) * 1000
          : Date.parse(header) - now()
        : 0;
      const delay = Math.max(
        requested || 0,
        Math.min(64000, 1000 * 2 ** attempt) + Math.random() * 1000,
      );
      notify(delay);
      await sleep(delay);
      return true;
    },
  };
}
