# Fork merge 2026-11-13: upstream 1.40.0 into local/keyword-search-providers

Merge of `origin/main` (4e274c20, VERSION 1.40.0) into the fork branch. Rule: where
upstream has an equivalent, upstream wins and ours is dropped; fork-only features
(keyword search, student facets, whole-board modes, `keywordSearch` marker) stay.
Fork version: package.json `1.40.0-cj.1`; VERSION stays `1.40.0`.

## Conflicted files

- `package.json` — upstream description and dependencies; version `1.40.0-cj.1`.
- `providers/apple.mjs` — upstream query/teams mode is the base; our whole-board mode (filtered jobs.apple.com careers_url, no `apple.queries/teams`) is appended as `fetchBoard`, with structured `truncated` on a shortfall. Upstream's looser `detect` kept.
- `providers/avature.mjs` — ours as base (keyword pinning, page-size learning, multi-key self-heal); upstream parsing added (icon-address location, `article--jobs` cards, h3 title anchor, `FolderDetail`, non-http link drop, query `jobId`, `assertParsedSomething`, `countArticles`) and upstream stall rule (a page whose cards were all dropped still advanced; a page 0 shorter than 6 ends the board).
- `providers/eightfold.mjs` — upstream v2 loop (branded host, PCSX fallback on first-page 403, 429 partial) is the base; our explicit `eightfold_mode` (pcsx / v2 / auto) and our PCSX query, location, filters and domain discovery kept, merged into one `buildPcsxUrl`.
- `providers/google.mjs` — upstream query mode is the base; our ds:1 island whole-board mode kept as `fetchBoard` (used when there is no `google` block and the careers_url is a filtered results URL).
- `providers/icims.mjs` — ours (crawl + keyword mode) plus upstream `err.firstPage` and the `fallback_urls` host loop for the full crawl.
- `providers/jibeapply.mjs` — ours (keyword/facet) plus upstream opt-in `page_size`, probe rethrow, failed-page truncation and accurate at-cap message; our 5000-page ceiling kept.
- `providers/oraclecloud.mjs` — upstream auto-raise to the reported total, `source-cap` on an empty page short of the total, structured `truncated`; our keyword/facet paths kept; `max_pages` clamped to 100 (API returns empty pages past offset 10000).
- `providers/radancy.mjs` — our keyword mode plus upstream probing, effective max pages and `stopReason` handling (replaces our walkedAllPages note).
- `providers/smartrecruiters.mjs` — upstream 100-page hard cap, retry policy, listingIdentity mapping and total-based cap detection; our keyword walk kept and rewritten on those rules. Entries with `max_pages` 500/1000 are now held to 100 pages.
- `providers/successfactors.mjs` — upstream ceilings, https-only host check, CSB sweep crawl and RMK raw-id paging; our keyword/location/facet filters, `/go/<Name>/<id>/` category filter and ids kept inside those crawls.
- `providers/taleo.mjs` — ours kept (portalCode section, US LOCATION refilter, truncation warning, now also structured `truncated`); ported from upstream: tre.taleo.net rejection and opt-in `fetchDetails` (JSON-LD detail). Upstream's shell + portal-id flow not taken: ours already covers the same boards.
- `providers/workday.mjs` — ours (student facet, keyword terms, `crawl` wrapper per query) plus upstream: location-aware `chooseSplitFacet`, `isClamped` with `exclude`, `STOP_REASON` constants, dead-board confirmation on page 0 (404), split under-coverage check, structural vs transient `workdayTruncated` reasons, page-cap structured `truncated`, multi-location placeholder enrichment (now applied to keyword results too). Keyword-mode partials now carry `truncated = { reason: 'incomplete', fetched }`.
- `tests/providers/apple.test.mjs`, `tests/providers/google.test.mjs` — upstream files; our tests moved to `apple-board.test.mjs` / `google-board.test.mjs` and adjusted to the merged detect/guards.
- `tests/providers/oraclecloud.test.mjs` — both sides; our default-cap test expects the upstream auto-raise (8175).
- `tests/providers/radancy.test.mjs` — both sides; our "broken walk" assertion dropped (upstream retries; its own later-page test covers it).
- `tests/providers/smartrecruiters.test.mjs` — both sides joined.
- `tests/providers/successfactors.test.mjs` — both sides; upstream `/go/` tests expect our category tile API.
- `tests/providers/taleo.test.mjs` — ours plus ported detail and tre tests.
- `tests/providers/workday-facet-split.test.mjs` — both sides (our active-facet test and upstream coverage tests).

## Non-conflict follow-ups in the same merge

- `tests/providers/jibeapply.test.mjs`, `eightfold-pcsx.test.mjs`, `smartrecruiters-keywords.test.mjs`, `workday-keywords.test.mjs` — expectations moved to upstream behaviour (jibeapply at-cap message, retry needs a status, `requisitionId` field, structured `truncated`, `'transient'` reason).
- `providers/adpwfn.mjs`, `selectminds.mjs`, `ukg.mjs` — local `sleep` replaced by the shared one from `_http.mjs` (upstream guard test).
- `providers/activate.mjs`, `bestbuy.mjs`, `apple.mjs`, `eightfold.mjs` — job URLs use `safeEncodeURIComponent` (upstream guard test).
