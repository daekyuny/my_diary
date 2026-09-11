import * as google from '../google.js';
const TITLE = '__MyDiaryLock';
const LEASE = 10 * 60 * 1000;
const queues = new Map();
const json = async (path, options) => (await google.request(path, options)).json();
const post = (requests) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ requests }),
});

// A sheet title is unique. Adding the hidden lock and its lease in one atomic batch
// gives separate browsers an exclusive writer without another database or credentials.
export async function withSheetLock(id, work) {
  const previous = queues.get(id) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => turn);
  queues.set(id, queued);
  await previous.catch(() => {});
  const path = `sheets/v4/spreadsheets/${id}`;
  const lockId = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
  let acquired = false;
  const deadline = Date.now() + 25000;
  const lease = () => ({
    updateCells: {
      start: { sheetId: lockId, rowIndex: 0, columnIndex: 0 },
      rows: [{ values: [{ userEnteredValue: { stringValue: String(Date.now() + LEASE) } }] }],
      fields: 'userEnteredValue',
    },
  });
  try {
    while (!acquired) {
      try {
        await json(
          `${path}:batchUpdate`,
          post([
            {
              addSheet: {
                properties: {
                  sheetId: lockId,
                  title: TITLE,
                  hidden: true,
                  gridProperties: { rowCount: 1, columnCount: 1 },
                },
              },
            },
            lease(),
          ]),
        );
        acquired = true;
      } catch (error) {
        const meta = await json(`${path}?fields=sheets.properties`);
        const lock = meta.sheets.find((sheet) => sheet.properties.title === TITLE)?.properties;
        if (!lock) throw error;
        // A timed-out acquisition may have committed successfully.
        if (lock.sheetId === lockId) {
          acquired = true;
          break;
        }
        const data = await json(
          `${path}/values:batchGet?ranges=${encodeURIComponent(`'${TITLE}'!A1:A1`)}`,
        );
        const expires = Number(data.valueRanges?.[0]?.values?.[0]?.[0]);
        if (expires && expires < Date.now()) {
          // The old ID cannot identify a replacement lock created by another browser.
          try {
            await json(`${path}:batchUpdate`, post([{ deleteSheet: { sheetId: lock.sheetId } }]));
          } catch (failure) {
            if (failure.status !== 400) throw failure;
          }
          continue;
        }
        if (Date.now() >= deadline)
          throw new Error(
            '다른 기기에서 시트를 저장 중입니다. 잠시 후 동기화를 다시 시도해주세요. 입력 내용은 기기에 저장되어 있습니다.',
          );
        await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 500));
      }
    }
    // Renew before each logical write; a crashed browser leaves a recoverable lease.
    return await work(async () => {
      await json(`${path}:batchUpdate`, post([lease()]));
    });
  } finally {
    if (acquired) {
      try {
        await json(`${path}:batchUpdate`, post([{ deleteSheet: { sheetId: lockId } }]));
      } catch {
        /* The lease permits recovery if the network disappears during release. */
      }
    }
    release();
    if (queues.get(id) === queued) queues.delete(id);
  }
}
