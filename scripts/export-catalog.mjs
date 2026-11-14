#!/usr/bin/env node
/**
 * export-catalog.mjs — export the shareable company catalog from a private portals.yml.
 *
 * The catalog keeps only the technical scan settings of each tracked company (name, careers_url,
 * provider and its parameters) plus the generic keyword_search block. Personal settings
 * (title_filter, location_filter, search_queries) and every YAML comment are dropped. Each
 * company gets a status: ok, browser (the site needs a browser read) or broken (disabled).
 *
 * Usage:
 *   node scripts/export-catalog.mjs [--in portals.yml] [--out templates/portals.catalog.yml]
 *                                   [--deny <file with one regex per line>]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fields that describe how to scan a company. Anything else on an entry is dropped.
const COMPANY_FIELDS = [
  'name', 'careers_url', 'api', 'provider', 'facet', 'keywords', 'query', 'max_jobs', 'max_pages',
  'timeout_ms', 'eightfold_mode', 'phenom', 'ibm', 'amazon', 'country', 'locationId', 'filters',
];

export function companyStatus(entry) {
  if (entry.enabled === false) return 'broken';
  if (entry.provider === 'browser-only') return 'browser';
  return 'ok';
}

export function toCatalog(portals) {
  const companies = (portals.tracked_companies || []).map((entry) => {
    const out = {};
    for (const field of COMPANY_FIELDS) if (entry[field] !== undefined) out[field] = entry[field];
    out.status = companyStatus(entry);
    return out;
  });
  const catalog = {};
  if (portals.keyword_search) catalog.keyword_search = portals.keyword_search;
  catalog.tracked_companies = companies;
  return catalog;
}

// Returns the denied patterns found in the text, ignoring the values of company `name` fields
// (public employer names such as "Northwestern Mutual" are allowed).
export function deniedHits(text, patterns) {
  const scrubbed = text.replace(/^(\s*-?\s*name:\s*).*$/gm, '$1<name>');
  const hits = [];
  for (const source of patterns) {
    const re = new RegExp(source, 'i');
    const match = scrubbed.match(re);
    if (match) hits.push({ pattern: source, match: match[0] });
  }
  return hits;
}

const HEADER = `# Company catalog for the CareerOps portal scanner (exported by scripts/export-catalog.mjs).
# Shared list of employers with tested scan settings. It is not a personal configuration:
# pick the companies that fit your search and build your own portals.yml with
#   node scripts/build-portals.mjs --select <names.txt>
# status: ok = scanned by the provider; browser = the site blocks scripted requests, read it in a
# browser; broken = disabled, left here for reference.
`;

function main(argv) {
  const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const input = arg('--in', join(ROOT, 'portals.yml'));
  const output = arg('--out', join(ROOT, 'templates', 'portals.catalog.yml'));
  const denyFile = arg('--deny', null);
  const portals = yaml.load(readFileSync(input, 'utf8'));
  const text = HEADER + yaml.dump(toCatalog(portals), { lineWidth: 200, noRefs: true });
  const patterns = [
    '[\\u4e00-\\u9fff]', // comments are dropped; any CJK left would be a personal note
    '\\buser\\b',
    '@[a-z0-9.-]+\\.(edu|com)',
    '\\b\\d{3}[-. )]+\\d{3}[-. ]\\d{4}\\b',
  ];
  if (denyFile && existsSync(denyFile)) {
    patterns.push(...readFileSync(denyFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  }
  const hits = deniedHits(text, patterns);
  if (hits.length) {
    console.error('Denied content in the catalog, nothing written:');
    for (const hit of hits) console.error(`  ${hit.pattern} → ${hit.match}`);
    process.exit(1);
  }
  writeFileSync(output, text);
  const companies = toCatalog(portals).tracked_companies;
  const count = (s) => companies.filter((c) => c.status === s).length;
  console.log(`Wrote ${output}: ${companies.length} companies (ok ${count('ok')}, browser ${count('browser')}, broken ${count('broken')})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
