#!/usr/bin/env node
/**
 * build-portals.mjs — build a personal portals.yml from the shared company catalog.
 *
 * An agent (or the user) picks the companies that fit the search and lists their names, one per
 * line, in a text file. This script copies those catalog entries into portals.yml. Names match the
 * catalog exactly, ignoring case. Unknown names stop the build so nothing is silently skipped.
 *
 * Usage:
 *   node scripts/build-portals.mjs --select names.txt [--catalog templates/portals.catalog.yml]
 *                                  [--base templates/portals.example.yml] [--out portals.yml]
 *
 * --base supplies the personal settings (title_filter, location_filter, search_queries, ...);
 * its own tracked_companies are ignored. keyword_search comes from the base when it has one,
 * otherwise from the catalog.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function readNames(text) {
  return text.split('\n').map((s) => s.replace(/#.*$/, '').trim()).filter(Boolean);
}

export function buildPortals(catalog, names, base = {}) {
  const byName = new Map();
  for (const entry of catalog.tracked_companies || []) byName.set(entry.name.toLowerCase(), entry);
  const missing = [];
  const seen = new Set();
  const companies = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = byName.get(key);
    if (!entry) { missing.push(name); continue; }
    const { status, ...settings } = entry;
    companies.push({ ...settings, enabled: status !== 'broken' });
  }
  const portals = {};
  for (const [key, value] of Object.entries(base)) if (key !== 'tracked_companies') portals[key] = value;
  if (!portals.keyword_search && catalog.keyword_search) portals.keyword_search = catalog.keyword_search;
  portals.tracked_companies = companies;
  return { portals, missing };
}

function main(argv) {
  const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const select = arg('--select', null);
  if (!select) {
    console.error('Usage: node scripts/build-portals.mjs --select names.txt [--catalog …] [--base …] [--out …]');
    process.exit(2);
  }
  const catalog = yaml.load(readFileSync(arg('--catalog', join(ROOT, 'templates', 'portals.catalog.yml')), 'utf8'));
  const basePath = arg('--base', join(ROOT, 'templates', 'portals.example.yml'));
  const base = existsSync(basePath) ? yaml.load(readFileSync(basePath, 'utf8')) || {} : {};
  const out = arg('--out', join(ROOT, 'portals.yml'));
  const { portals, missing } = buildPortals(catalog, readNames(readFileSync(select, 'utf8')), base);
  if (missing.length) {
    console.error(`Not in the catalog (add them first, then rebuild): ${missing.join(', ')}`);
    process.exit(1);
  }
  if (existsSync(out) && !argv.includes('--force')) {
    console.error(`${out} exists; pass --force to overwrite it`);
    process.exit(1);
  }
  writeFileSync(out, yaml.dump(portals, { lineWidth: 200, noRefs: true }));
  console.log(`Wrote ${out}: ${portals.tracked_companies.length} companies`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
