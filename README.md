# use cache: the stale-hit background revalidation replaces the request's Resume Data Cache entry

When a request serves a stale `"use cache"` entry, past `revalidate` but within `expire`, Next.js serves it and regenerates it in the background.
That background revalidation also writes its pending result into the request's Resume Data Cache (RDC), replacing the entry the request was served.
Any later render of the same request that reads the RDC then gets the in-flight regeneration instead of the served value.

Two renders read it, with two visible effects:

- **`next dev`: a false "uncached data" error.** Dev validation re-renders from the RDC, waits on the regeneration's `fetch`, and reports the component as uncached data, on a route `next build` prerenders as fully static.
  It reproduces with the built-in `"use cache"` handler.
- **Production, with `partialPrefetching`: a runtime prefetch that does not match the response.** The runtime prefetch embedded in the response is rendered from the same RDC.
  On a stale hit it is either cut off without the cached content, or waits for the regeneration and carries the new value next to the served one, while the HTML and the main RSC payload carry the served value.
  Which of the two happens is a race: 16.3.5 mostly waits, 16.3.8 and later mostly cut it off.
  The built-in handler is not exposed in production, because it drops entries at `revalidate`; a custom handler that serves stale entries until `expire`, as the 16.4 `cacheHandlers` docs describe, is.

Both reproduce on 16.3.5, 16.3.8, 16.4.0 and 16.5.0-canary.3.
A one-line change that keeps the background revalidation out of the RDC removes both.

```text
Error: Route "/other": Next.js encountered uncached data during prerendering.

`fetch(...)` or `connection()` accessed outside of `<Suspense>` prevents the route from being prerendered, blocking the page load and leading to a slower user experience.
...
    at Banner (app/banner.tsx:4:33)
    at RootLayout (app/layout.tsx:8:9)
```

## Running it

```bash
pnpm install
pnpm repro            # next dev scenarios, about 2 minutes
pnpm repro:prod       # next build + next start scenarios, about 3 minutes
```

`scripts/repro.mjs` starts a local data server and a fresh `next dev` per scenario, loads routes on a timed schedule, and counts the error lines `next dev` prints after each load.
It exits with 1 when the error appears outside the `control` scenario.

`scripts/prod.mjs` starts the data server, runs `next build` and `next start` per scenario, requests `/dynamic` on a timed schedule, and counts the copies of the cached greeting in each response.
It exits with 1 when a response carries fewer copies than the fresh responses of the same scenario.

Both write the full server output to `results/<next version>_<scenario>.log` and take scenario names as arguments.
`scripts/matrix.sh` runs every row of the tables below into `results/summary.tsv`, in about 40 minutes.
It installs each Next.js version in turn, then restores `package.json`, the lockfile and `node_modules`.

## The app

Everything follows the Next.js 16.4 rules for Cache Components:

- `next.config.ts`: `cacheComponents: true`, `partialPrefetching: true` (`PARTIAL_PREFETCHING=false` turns it off), and one `cacheLife` profile, `short-revalidate`: `revalidate: 10`, `expire: 3600`, `stale` inherited from `default` (5 minutes).
  That profile is prerenderable: `revalidate` above 0 and `expire` of at least 5 minutes.
  Its 5-minute `stale` also keeps it in the App Shell.
- The data server answers each request with a version number counted per source, after 500 ms.
- `app/layout.tsx` (root layout) renders `<Banner />`, which awaits `getBanner()`: `"use cache"` + `cacheLife("short-revalidate")` around a `fetch`.
- `app/page.tsx` is static. `app/other/page.tsx` awaits `getOther()`: `"use cache"` + `cacheLife("hours")` around a 50 ms `fetch`.
- `app/dynamic/page.tsx` reads `cookies()` inside `<Suspense>`, then awaits `getGreeting()`: `"use cache"` + `cacheLife("short-revalidate")` around a `fetch`.
  Because it comes after the cookie read, every request reads the greeting from the cache handler.
- `cache-handler.js` (`CACHE_HANDLER=builtin` swaps in the built-in handler) is the "Basic in-memory cache handler" of the 16.4 `cacheHandlers` docs, plus eviction at `expire` and a check that reports an entry past `expire` as missing.
  It returns entries past `revalidate`, which the 16.4 docs describe as valid: "Past `revalidate` but within `expire`, the entry is served and a fresh one is generated in the background".
  `HANDLER_AGE_CHECK=false` removes the `expire` check, and with it the only clock read in `get`.
- No `connection()`, no request APIs outside `<Suspense>`, no clock reads in components.

`next build` prints `/`, `/other` and `/_not-found` as `○ (Static)` and `/dynamic` as `◐ (Partial Prerender)`, with no error, for both handlers.

## Results

Node 24.16.0, pnpm 11.25.0, macOS 27 on arm64, React 19.3.0, Turbopack.
Every row was run back to back by `scripts/matrix.sh`.

### next dev

| scenario | handler | schedule (seconds after the first load) |
| --- | --- | --- |
| `builtin` | built-in | `/` at 0 and 3, `/other` at 15 (banner stale, `/other` data cold) and 18 |
| `control` | built-in | `/` at 0, `/other` at 3 (banner fresh, `/other` data cold) and 6 |
| `custom` | `cache-handler.js` | `/` at 0, 3, 15 (stale), 18, 21, 45 (stale), 48 |

Error lines logged per load:

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
| `PARTIAL_PREFETCHING=false` | 0, 0, 0, 0 in the matrix run; 0, 0, **1**, 0 in 3 of 3 reruns | 0, 0, **1**, 0, 0, **1**, 0 |
| `DATA_DELAY_MS=0` (data answers at once) | 0, 0, 0, 0 | 0, 0, 0, 0, 0, 0, 0 in the matrix run; 0, 0, **1**, 0, 0, 0, 0 in 2 of 2 reruns |
| `HANDLER_AGE_CHECK=false` (no clock read in the handler's `get`) | n/a | 0, 0, 0, 0, 0, 0, 0 |
| candidate fix (`scripts/apply-candidate-fix.mjs`) | 0, 0, 0, 0 | 0, 0, 0, 0, 0, 0, 0 |

### next start

`/dynamic` requested at 0 s (cold), 3 s, 15 s (greeting stale), 18 s as documents, then at 30 s (stale) and 33 s as RSC navigation requests (`RSC: 1`).
A document carries the greeting in the HTML, in the inline RSC payload and, with `partialPrefetching`, in the embedded runtime prefetch.
An RSC response carries it in the payload and in the runtime prefetch.

Greeting copies per response, the version they show, and the response time:

| Next.js | handler | `partialPrefetching` | doc 0 s (cold) | doc 3 s | doc 15 s (stale) | doc 18 s | RSC 30 s (stale) | RSC 33 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16.3.5 | custom | true | 3 (v1) 680 ms | 3 (v1) 16 ms | **2** (v1) 95 ms | 3 (v2) 10 ms | 2 (**v2 + v3**) **535 ms** | 2 (v3) 36 ms |
| 16.3.8 | custom | true | 3 (v1) 584 ms | 3 (v1) 27 ms | **2** (v1) 32 ms | 3 (v2) 18 ms | **1** (v2) 30 ms | 2 (v3) 18 ms |
| 16.4.0 | custom | true | 3 (v1) 705 ms | 3 (v1) 21 ms | **2** (v1) 35 ms | 3 (v2) 10 ms | **1** (v2) 30 ms | 2 (v3) 17 ms |
| 16.5.0-canary.3 | custom | true | 3 (v1) 600 ms | 3 (v1) 10 ms | **2** (v1) 23 ms | 3 (v2) 14 ms | **1** (v2) 15 ms | 2 (v3) 16 ms |
| 16.4.0 | custom | false | 2 (v1) 613 ms | 2 (v1) 21 ms | 2 (v1) 68 ms | 2 (v2) 224 ms | 1 (v2) 11 ms | 1 (v3) 15 ms |
| 16.4.0 | built-in | true | 3 (v1) 610 ms | 3 (v1) 22 ms | 3 (v2) 540 ms | 3 (v2) 12 ms | 2 (v3) 537 ms | 2 (v3) 14 ms |
| 16.4.0 + candidate fix | custom | true | 3 (v1) 597 ms | 3 (v1) 23 ms | 3 (v1) 31 ms | 3 (v2) 30 ms | 2 (v2) 29 ms | 2 (v3) 19 ms |

The RSC 30 s (stale) column is a race between the runtime prefetch and the regeneration.
Counting this run and later runs of `pnpm repro:prod custom`, the stale RSC response waited about 530 ms and carried v2 + v3 in 5 of 6 runs on 16.3.5 and 1 of 6 on 16.3.8.
It carried 1 copy, with no wait, in every other run, including 7 of 7 on 16.4.0 and 2 of 2 on 16.5.0-canary.3.

### What the tables say

- **Only a request that serves a stale entry is affected.** The request right after the regeneration is clean, and carries the new version everywhere.
- **In dev, the built-in handler is enough.** It needs the stale hit to coincide with a cache miss elsewhere in the same request: the first visit to `/other`.
  The same first visit while the banner is fresh (`control`) is clean.
- **In dev with the custom handler, every stale hit logs it,** with no other cache miss needed (see [the amplifier](#amplifier-the-custom-handlers-clock-read-forces-the-re-render)).
- **In production, the runtime prefetch of a stale-hit response does not carry the served value.**
  The stale document carries 2 copies instead of 3, and is not slower.
  The stale RSC response either leaves it out too, 1 copy instead of 2, or waits for the regeneration (about 530 ms instead of about 20 ms) and carries two versions: the served v2 in the payload, the regenerated v3 in the runtime prefetch.
  Both happen on 16.3.5 and 16.3.8: 16.3.5 mostly waits, 16.3.8 and later mostly leave it out.
- **Without `partialPrefetching` there is no runtime prefetch, and production is unaffected.** The dev error does not depend on the flag.
- **The built-in handler never serves a stale entry in production:** it regenerates in the foreground, so the stale request takes 500 ms more and carries the new version everywhere.
- **It is a race with the background regeneration.** With a data source that answers at once, the dev `builtin` scenario stops reproducing and the `custom` one reproduces less often.
  The race also explains the one `PARTIAL_PREFETCHING=false` run without the error.
- **16.3.5 already has it.**

## Where it comes from

Line numbers are from the [v16.4.0 sources](https://github.com/vercel/next.js/tree/v16.4.0/packages/next/src).

1. **The stale hit is served and put in the request's RDC.**
   On a cache handler hit, the wrapper clones the entry and stores one branch in the request's mutable RDC, so later renders of the same request reuse what was served
   ([use-cache-wrapper.ts#L3653-L3677](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L3653-L3677)).
2. **The background revalidation then overwrites that RDC entry with its own pending result.**
   Because the entry is past `revalidate`, the same lookup starts a background regeneration with `skipPropagation: true`.
   As soon as the generation starts, `saveToResumeDataCache(resumeDataCache, serializedCacheKey, pendingCacheResult, ...)` replaces the RDC entry with a promise that settles only when the regeneration, and its `fetch`, finish
   ([use-cache-wrapper.ts#L3751-L3790](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L3751-L3790), `saveToResumeDataCache` at [#L526-L546](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L526-L546)).
   `NEXT_PRIVATE_DEBUG_CACHE=1` shows the order: `leader resolved with cache handler hit`, then `Resume Data Cache entry saved`, then the data request.
3. **A later render of the request reads the RDC and gets the in-flight regeneration.**
   The `"use cache"` call reads it with `let rdcResult = await rdcEntry`
   ([use-cache-wrapper.ts#L2515](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L2515)).
   - **Dev validation.** After the response, validation reuses the main render unless it had a cache miss or a sync I/O interrupt ([app-render.tsx#L5100-L5103](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/app-render/app-render.tsx#L5100-L5103)).
     Otherwise it re-renders with warm caches. In the `builtin` scenario, `/other`'s own miss forces that re-render. When the main render had a cache miss, validation first waits for `cacheSignal.cacheReady()` ([app-render.tsx#L6219-L6222](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/app-render/app-render.tsx#L6219-L6222)), but that wait does not cover the background regeneration. After a sync I/O interrupt alone, as in the `custom` scenario, it does not wait at all.
     The read does not resolve in the static stage, and validation reports uncached data.
     Instrumenting the RDC read on the failing load measured a 493 ms wait for the 500 ms `fetch`; on every other load it resolves at once.
   - **Production runtime prefetch.** With `partialPrefetching`, a dynamic render gets a mutable RDC and, once `cacheSignal.cacheReady()` resolves, spawns a `prerender-runtime` render from it whose output is embedded in the response ([app-render.tsx#L1015-L1047](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/app-render/app-render.tsx#L1015-L1047), [#L3927-L3956](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/app-render/app-render.tsx#L3927-L3956), `spawnRuntimePrefetchWithFilledCaches` at [#L1134](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/app-render/app-render.tsx#L1134)).
     On a stale hit that render reads the pending regeneration instead of the served entry.
     Either it finishes without it: the runtime prefetch stream in the response lacks the row holding the greeting.
     Or it waits for the regeneration and embeds the new value next to the served one, which 16.3.5 does in most runs.

The candidate fix keeps the background revalidation out of the request's RDC: it writes the regenerated entry to the cache handler only, and the RDC keeps the entry the request was served.
It is one line in the 16.4.0 build, applied by `scripts/apply-candidate-fix.mjs`:

```diff
 const { stream: ignoredStream, pendingCacheResult } = result
-const savedCacheResult = saveToResumeDataCache(resumeDataCache, serializedCacheKey, pendingCacheResult, logPrefix)
+const savedCacheResult = pendingCacheResult
```

With it, every dev scenario is clean and every production response carries all its copies.

### Amplifier: the custom handler's clock read forces the re-render

In dev, a custom handler is read through a tiered handler: a built-in in-memory front, plus a background `reconcileFrontFromBacking` that calls the custom `get` after each front hit
([tiered-cache-handler.ts#L78-L90](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/tiered-cache-handler.ts#L78-L90), [#L137-L145](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/tiered-cache-handler.ts#L137-L145)).
That call runs in the request's async context, so the `Date.now()` in the handler's `expire` check is recorded on the main render as a sync I/O interrupt (`Next.js encountered the unstable value Date.now() while prerendering`).
Nothing is logged for it, but it rules out reusing the main render, so every request re-renders for validation, and every stale hit runs into the RDC overwrite.
`HANDLER_AGE_CHECK=false` removes the clock read and the dev error with it.
Reading the clock is ordinary in a cache handler: the 16.3 docs example compared `Date.now()` with `revalidate` in `get`, and TTL logic and store clients do the same.

### Checked and ruled out

- 16.4 replaced `workStore.isStaticGeneration` with `willConsumerServerCache(workUnitStore)` in the condition that regenerates a stale entry in the foreground ([use-cache-wrapper.ts#L3505](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/use-cache/use-cache-wrapper.ts#L3505)).
  Both are false for the `request` stores involved here, so the stale entry is served and regenerated in the background on both versions, which matches 16.3.5 reproducing.
- Prerenders do not take the background path: `willConsumerServerCache` is true for `prerender` stores, so a stale hit during a prerender (ISR revalidation, fallback shell upgrade) is regenerated in the foreground before the prerender uses it.
- The built-in handler serves stale entries until `expire` in dev too ([default.ts#L114-L120](https://github.com/vercel/next.js/blob/v16.4.0/packages/next/src/server/lib/cache-handlers/default.ts#L114-L120)), so the dev difference between the handlers is not stale versus fresh: it is whether something forces the validation re-render.

## Notes

- `next dev` writes `AGENTS.md` and `CLAUDE.md` at the root; they are ignored.
- `scripts/apply-candidate-fix.mjs` writes to a temporary file and renames it over the original, so a pnpm store linked by hardlinks is never modified.
  Undo it with `rm -rf node_modules && pnpm install --frozen-lockfile`.
