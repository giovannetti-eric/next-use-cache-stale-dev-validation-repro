// @ts-check
// Custom "use cache" handler following the Next.js 16.4 cacheHandlers contract
// (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheHandlers.md).
// It is the docs' "Basic in-memory cache handler" example plus two things a real handler has:
//
// - Eviction ("Eviction is yours"): each entry is deleted once it is past `expire`.
// - An `expire` check: an entry past `expire` is reported as missing. The docs say a handler
//   does not need it, since Next.js compares `timestamp` with `expire` on every read, so this
//   only duplicates it, the way TTL logic in a real store does. An entry past `revalidate` but
//   within `expire` is returned, which the docs describe as serving it and regenerating it in
//   the background.
//
// HANDLER_AGE_CHECK=false removes the `expire` check, so `get` never reads the clock.

/** @typedef {import("next/cache").CacheEntry} CacheEntry */
/** @typedef {Omit<CacheEntry, "value"> & { value: Uint8Array }} StoredEntry */

/** @type {Map<string, StoredEntry>} */
const cache = new Map();
/** @type {Map<string, Promise<void>>} */
const pendingSets = new Map();

const ageCheck = process.env.HANDLER_AGE_CHECK !== "false";
const log = process.env.HANDLER_LOG ? (/** @type {string} */ message) => console.info(`[cache-handler] ${message}`) : undefined;

/** @param {Uint8Array} bytes */
function streamFromBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** @type {import("next/cache").CacheHandler} */
module.exports = {
  async get(cacheKey, _softTags) {
    const pendingPromise = pendingSets.get(cacheKey);
    if (pendingPromise) {
      await pendingPromise;
    }

    const entry = cache.get(cacheKey);
    if (!entry) {
      log?.(`get miss ${cacheKey.slice(0, 60)}`);
      return undefined;
    }
    if (log) {
      const age = Date.now() - entry.timestamp;
      log(`get ${age > entry.revalidate * 1000 ? "stale" : "fresh"} hit, age ${Math.round(age / 1000)} s, ${cacheKey.slice(0, 60)}`);
    }

    if (ageCheck && Date.now() > entry.timestamp + entry.expire * 1000) {
      return undefined;
    }

    // Every hit gets its own stream over the stored bytes
    return { ...entry, value: streamFromBytes(entry.value) };
  },

  async set(cacheKey, pendingEntry) {
    /** @type {() => void} */
    let resolvePending = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolvePending = () => resolve(undefined);
    });
    pendingSets.set(cacheKey, pendingPromise);

    try {
      const entry = await pendingEntry;
      // Consume the stream, then keep the data rather than the stream
      const value = new Uint8Array(await new Response(entry.value).arrayBuffer());
      const stored = { ...entry, value };
      cache.set(cacheKey, stored);
      log?.(`set ${cacheKey.slice(0, 60)}`);

      // Eviction: drop the entry once it is past `expire`, unless a newer one replaced it
      setTimeout(() => {
        if (cache.get(cacheKey) === stored) cache.delete(cacheKey);
      }, entry.expire * 1000).unref();
    } catch (error) {
      console.error("[cache-handler] set failed", error);
    } finally {
      resolvePending();
      pendingSets.delete(cacheKey);
    }
  },

  async refreshTags() {
    // No-op for an in-memory cache
  },

  async getExpiration(_tags) {
    // No tag is ever revalidated in this app
    return 0;
  },

  async updateTags(tags, _durations) {
    for (const [key, entry] of cache.entries()) {
      if (entry.tags.some((tag) => tags.includes(tag))) {
        cache.delete(key);
      }
    }
  },
};
