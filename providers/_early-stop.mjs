// @ts-check
// Early stop with a completion boundary for date-ordered lists (career-journal plan 2026-11-14 v3.1).
//
// A caller that already has a list's listings passes ctx.isKnownListing(job) and ctx.earlyStopBeforeMs (the last
// complete read of that list minus a safety margin). A provider whose request sorts newest-first by the same date it
// reports as postedAt (Oracle Cloud POSTING_DATES_DESC → PostedDate; Taleo sortBySelectionParam 3 desc → the posting
// date column) asks page() after each page. The walk stops only when:
//   - every date read so far, across pages and within each page, has never gone up (an unordered list is never
//     stopped: the order is checked, not assumed);
//   - the page's last row carries a date, and it is before earlyStopBeforeMs (rows without a date never stop it);
//   - every row on the page is a listing the caller already has.
// Every stream (one search query) ends with a status; combineCollection() folds them for the whole list.

/** @typedef {'complete' | 'early_stopped' | 'page_failed' | 'ceiling'} CollectionStatus */

/** @param {any} ctx */
export function createEarlyStop(ctx) {
  const before = Number(ctx?.earlyStopBeforeMs);
  const isKnown = typeof ctx?.isKnownListing === 'function' ? ctx.isKnownListing : null;
  if (!Number.isFinite(before) || !isKnown) return null;
  let last = Infinity;
  let ordered = true;
  return {
    /** @param {any[]} jobs one page of parsed rows, in list order @returns {boolean} stop here */
    page(jobs) {
      for (const job of jobs) {
        if (typeof job?.postedAt !== 'number') continue;
        if (job.postedAt > last) ordered = false;
        last = job.postedAt;
      }
      if (!ordered || !jobs.length) return false;
      const tail = jobs[jobs.length - 1];
      if (typeof tail?.postedAt !== 'number' || !(tail.postedAt < before)) return false;
      return jobs.every((job) => isKnown(job));
    },
  };
}

const RANK = { complete: 0, early_stopped: 1, ceiling: 2, page_failed: 3 };
/** @param {CollectionStatus[]} statuses @returns {CollectionStatus} */
export function combineCollection(statuses) {
  let worst = /** @type {CollectionStatus} */ ('complete');
  for (const status of statuses) if ((RANK[status] ?? 0) > RANK[worst]) worst = status;
  return worst;
}

// Tags a job array with its collection status. Not enumerable, so the array still compares and serialises as plain
// rows; callers read jobs.collection.
/** @param {any[]} jobs @param {CollectionStatus} status @param {Array<{key: string, status: CollectionStatus}>} [streams] */
export function markCollection(jobs, status, streams) {
  Object.defineProperty(jobs, 'collection', { value: { status, ...(streams ? { streams } : {}) }, enumerable: false, configurable: true, writable: true });
  return jobs;
}
