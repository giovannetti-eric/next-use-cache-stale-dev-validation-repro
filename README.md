# use cache stale hit: dev validation false positive

Reproduction of a false positive in `next dev` with Cache Components.
When a request serves a stale `"use cache"` entry, past `revalidate` but within `expire`, `next dev` can log:

```text
Error: Route "/other": Next.js encountered uncached data during prerendering.
`fetch(...)` or `connection()` accessed outside of `<Suspense>` prevents the route from being prerendered, ...
    at Banner (app/banner.tsx:4:24)
    at RootLayout (app/layout.tsx:8:9)
```

The route is fully prerenderable: `next build` marks every route `○ (Static)` with no error, and the same request a few seconds later, or with the entry still fresh, logs nothing.
The error points at a component that awaits a `"use cache"` function, which is exactly the fix the error message suggests.

It reproduces with the built-in `"use cache"` handler, with a custom handler, with or without `partialPrefetching`, on 16.3.5, 16.3.8, 16.4.0 and 16.5.0-canary.3.

## Running it

```bash
pnpm install
pnpm repro            # node scripts/repro.mjs: every scenario, about 2 minutes
```

`scripts/repro.mjs` starts a local data server and a fresh `next dev` per scenario, loads routes on a timed schedule, and counts the error lines `next dev` prints after each load.
It exits with 1 when the error appears outside the `control` scenario.
Full server output lands in `results/<next version>_<scenario>.log`.
`node scripts/repro.mjs builtin` runs one scenario.

`scripts/matrix.sh` runs every row of the tables below into `results/summary.tsv`, in about 25 minutes.
It installs each Next.js version in turn, then restores `package.json`, the lockfile and `node_modules`.

## The app

Everything follows the Next.js 16.4 rules for Cache Components:

- `next.config.ts`: `cacheComponents: true`, `partialPrefetching: true`, and one custom `cacheLife` profile, `short-revalidate`: `revalidate: 10`, `expire: 3600`, `stale` inherited from `default` (5 minutes).
  That profile is prerenderable: `revalidate` above 0, `expire` of at least 5 minutes, `stale` of at least 5 minutes, so the entry belongs in the static shell and needs no `<Suspense>`.
- `app/layout.tsx` (root layout) renders `<Banner />`, which awaits `getBanner()`.
- `app/data.ts`: `getBanner()` is `"use cache"` + `cacheLife("short-revalidate")` around a `fetch` to the local data server, which answers after 500 ms.
  `getOther()` is `"use cache"` + `cacheLife("hours")` around a 50 ms `fetch`.
- `app/page.tsx` is static. `app/other/page.tsx` awaits `getOther()`.
- `cache-handler.js`, used only by the `custom` scenario, is the "Basic in-memory cache handler" of the 16.4 `cacheHandlers` docs, plus eviction at `expire` and a check that reports an entry past `expire` as missing.
  It returns entries past `revalidate`, which the 16.4 docs describe as valid: "Past `revalidate` but within `expire`, the entry is served and a fresh one is generated in the background".
- No `cookies()`, `headers()`, `params`, `searchParams`, `connection()` or `Date.now()` in any component.

`next build` (with the data server running) prints every route as `○ (Static)`, with `Revalidate 10s, Expire 1h`, for both handlers.

## Scenarios

| scenario | handler | schedule (seconds after the first load) |
| --- | --- | --- |
| `builtin` | built-in | `/` at 0 and 3, `/other` at 15 (banner stale, `/other` data cold) and 18 |
| `control` | built-in | `/` at 0, `/other` at 3 (banner fresh, `/other` data cold) and 6 |
| `custom` | `cache-handler.js` | `/` at 0, 3, 15 (stale), 18, 21, 45 (stale), 48 |

## Results

Node 24.16.0, pnpm 11.25.0, macOS 27 on arm64, React 19.3.0, Turbopack.
Error lines logged per load, every row run back to back by `scripts/matrix.sh`.

| Next.js | `builtin` | `control` | `custom` |
| --- | --- | --- | --- |
| 16.3.5 | 0, 0, **1**, 0 | 0, 0, 0 | 0, 0, **1**, 0, 0, **1**, 0 |
| 16.3.8 | 0, 0, **1**, 0 | 0, 0, 0 | 0, 0, **1**, 0, 0, **1**, 0 |
| 16.4.0 | 0, 0, **1**, 0 | 0, 0, 0 | 0, 0, **1**, 0, 0, **1**, 0 |
| 16.5.0-canary.3 | 0, 0, **1**, 0 | 0, 0, 0 | 0, 0, **1**, 0, 0, **1**, 0 |

Variants on 16.4.0:

| variant | `builtin` | `custom` |
| --- | --- | --- |
| none | 0, 0, **1**, 0 | 0, 0, **1**, 0, 0, **1**, 0 |
| `PARTIAL_PREFETCHING=false` | 0, 0, **1**, 0 | 0, 0, **1**, 0, 0, **1**, 0 |
| `DATA_DELAY_MS=0` (banner data answers at once) | 0, 0, 0, 0 | 0, 0, **1**, 0, 0, 0, 0 |
| `HANDLER_AGE_CHECK=false` (no clock read in the handler's `get`) | n/a | 0, 0, 0, 0, 0, 0, 0 |
| candidate fix (`scripts/apply-candidate-fix.mjs`) | 0, 0, 0, 0 | 0, 0, 0, 0, 0, 0, 0 |

What the tables say:

- **Only a load that serves a stale entry logs the error.** The loads that serve a fresh entry, including the one right after the regeneration, are clean.
- **The built-in handler is enough.** It needs the stale hit to coincide with a cache miss elsewhere in the same request: the first visit to `/other`.
  The same first visit while the banner is fresh (`control`) is clean.
- **With the custom handler, every stale hit logs it,** with no other cache miss needed.
- **`partialPrefetching` plays no part.**
- **It is a race with the background regeneration.** With a data source that answers at once, the built-in scenario stops reproducing and the custom one reproduces less often.
- **16.3.5 already has it.** Nothing here is new in 16.4.

## Where it comes from

Line numbers are from the [v16.4.0 sources](https://github.com/vercel/next.js/tree/v16.4.0/packages/next/src).

1. **The stale hit is served and put in the request's Resume Data Cache (RDC).**
   On a cache handler hit, the wrapper clones the entry and stores one branch in the request's mutable RDC, so later renders of the same request reuse what was served
   ([use-cache-wrapper.ts#L3653-L3677](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L3653-L3677)).
2. **The background revalidation then overwrites that RDC entry with its own pending result.**
   Because the entry is past `revalidate`, the same lookup starts a background regeneration with `skipPropagation: true`.
   As soon as the generation starts, `saveToResumeDataCache(resumeDataCache, serializedCacheKey, pendingCacheResult, ...)` replaces the RDC entry with a promise that settles only when the regeneration, and its `fetch`, finish
   ([use-cache-wrapper.ts#L3751-L3790](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L3751-L3790), `saveToResumeDataCache` at [#L526-L546](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L526-L546)).
   `NEXT_PRIVATE_DEBUG_CACHE=1` shows the order: `leader resolved with cache handler hit`, then `Resume Data Cache entry saved`, then the data request.
3. **Dev validation re-renders from that RDC, and the read now waits on uncached I/O.**
   After the response, dev validation reuses the main render unless it had a cache miss or a sync I/O interrupt
   ([app-render.tsx#L5100-L5103](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/app-render/app-render.tsx#L5100-L5103)).
   Otherwise it re-renders with warm caches, and the `"use cache"` call reads the RDC: `let rdcResult = await rdcEntry`
   ([use-cache-wrapper.ts#L2515](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L2515)).
   That promise is the in-flight regeneration, so the read does not resolve in the static stage, and validation reports the component as uncached data.
   Instrumenting that line on the failing load measured a 493 ms wait for the 500 ms `fetch`; on every other load it resolves at once.

What forces the re-render differs between the two scenarios:

- **`builtin`**: `/other`'s own `"use cache"` misses, so `result.hadCacheMiss` is true.
  Validation first waits for `cacheSignal.cacheReady()` ([app-render.tsx#L6219-L6222](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/app-render/app-render.tsx#L6219-L6222)), but that wait does not cover the background regeneration: the validation render still finds it pending in the RDC.
- **`custom`**: in dev, a custom handler is read through a tiered handler: a built-in in-memory front, plus a background `reconcileFrontFromBacking` that calls the custom `get` after each front hit
  ([tiered-cache-handler.ts#L78-L90](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/tiered-cache-handler.ts#L78-L90), [#L137-L145](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/tiered-cache-handler.ts#L137-L145)).
  That call runs in the request's async context, so the `Date.now()` in the handler's `expire` check is recorded on the main render as a sync I/O interrupt (`Next.js encountered the unstable value Date.now() while prerendering`).
  Nothing is logged for it, but it rules out reusing the main render, so every request re-renders for validation, and every stale hit hits the race.
  `HANDLER_AGE_CHECK=false` removes the clock read and the error with it.
  Reading the clock is ordinary in a cache handler: the 16.3 docs example compared `Date.now()` with `revalidate` in `get`, and Redis clients and TTL logic do the same.

The candidate fix keeps the background revalidation out of the request's RDC: it writes the regenerated entry to the cache handler only, and the RDC keeps the entry the request was served.
It is one line in the 16.4.0 build, applied by `scripts/apply-candidate-fix.mjs`:

```diff
 const { stream: ignoredStream, pendingCacheResult } = result
-const savedCacheResult = saveToResumeDataCache(resumeDataCache, serializedCacheKey, pendingCacheResult, logPrefix)
+const savedCacheResult = pendingCacheResult
```

Both scenarios are clean with it.

Two things checked and ruled out:

- 16.4 replaced `workStore.isStaticGeneration` with `willConsumerServerCache(workUnitStore)` in the condition that regenerates a stale entry in the foreground ([use-cache-wrapper.ts#L3505](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L3505)).
  Both are false for the `request` stores involved here, so the stale entry is served and regenerated in the background on both versions, which matches 16.3.5 reproducing.
- The built-in handler serves stale entries until `expire` in dev too ([default.ts#L114-L120](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/lib/cache-handlers/default.ts#L114-L120)), so the difference between the handlers is not stale versus fresh: it is whether something forces the validation re-render.

## Notes

- `next dev` writes `AGENTS.md` and `CLAUDE.md` at the root; they are ignored.
- `scripts/apply-candidate-fix.mjs` writes to a temporary file and renames it over the original, so a pnpm store linked by hardlinks is never modified.
  Undo it with `rm -rf node_modules && pnpm install --frozen-lockfile`.
