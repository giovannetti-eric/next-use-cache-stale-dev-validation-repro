// Applies the candidate fix to the installed next@16.4.0, for comparison runs only:
// the background revalidation started by a stale hit stops writing its pending
// regeneration into the request's Resume Data Cache, which keeps the entry the
// request was served.
//
//   node scripts/apply-candidate-fix.mjs
//
// The file is written to a temporary path and renamed over the original, so a package
// store linked by hardlinks is not modified. Undo with
// `rm -rf node_modules && pnpm install --frozen-lockfile`.
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const nextDir = realpathSync(`${root}node_modules/next`);
const version = JSON.parse(readFileSync(`${nextDir}/package.json`, "utf8")).version;
if (version !== "16.4.0") throw new Error(`the candidate fix targets next@16.4.0, found ${version}`);

const file = `${nextDir}/dist/server/use-cache/use-cache-wrapper.js`;
const source = readFileSync(file, "utf8");
const backgroundWrite =
  /(const \{ stream: ignoredStream, pendingCacheResult \} = result;\s*)const savedCacheResult = saveToResumeDataCache\(resumeDataCache, serializedCacheKey, pendingCacheResult, logPrefix\);/;
if (!backgroundWrite.test(source)) throw new Error("background revalidation write not found");

const patched = source.replace(backgroundWrite, "$1const savedCacheResult = pendingCacheResult;");
writeFileSync(`${file}.tmp`, patched);
renameSync(`${file}.tmp`, file);
console.info(`patched ${file}`);
