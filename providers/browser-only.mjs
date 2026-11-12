// @ts-check
// browser-only — a company whose official careers site answers scripts with a
// bot wall on every route (list and API alike) but renders in a real browser.
//
// The provider never makes a request. It fails the list on purpose, with the
// careers address the entry names, so the caller records the company as a
// failed list and hands it to its browser read (career-journal: `scan
// failed-lists` → a person or agent reads the site's own search in a browser →
// `scan attach`). Without an entry like this the company is simply absent from
// the scan and nobody is told to read it.
//
// portals.yml:
//   - name: "Tesla"
//     provider: "browser-only"
//     careers_url: "https://www.tesla.com/careers/search/?type=intern&site=US"

/** @typedef {import('./_types.js').Provider} Provider */

/**
 * @param {any} entry
 * @returns {URL}
 */
export function resolveCareersUrl(entry) {
  let url;
  try {
    url = new URL(String(entry?.careers_url));
  } catch {
    throw new Error(`browser-only: ${entry?.name}: careers_url must be an absolute URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`browser-only: ${entry?.name}: careers_url must use HTTPS`);
  if (url.username || url.password) throw new Error(`browser-only: ${entry?.name}: careers_url must not carry credentials`);
  return url;
}

/** @type {Provider} */
export default {
  id: 'browser-only',

  detect() {
    return null; // explicit `provider: browser-only` only
  },

  async fetch(entry) {
    const url = resolveCareersUrl(entry);
    throw new Error(`browser-only: ${entry.name}: ${url.host} blocks scripted requests (bot challenge) — needs a browser read`);
  },
};
