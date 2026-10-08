import type { NextConfig } from "next";

// CACHE_HANDLER=builtin runs the same app on the built-in "use cache" handler (control).
// PARTIAL_PREFETCHING=false turns Partial Prefetching off.
const useCustomHandler = process.env.CACHE_HANDLER !== "builtin";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: process.env.PARTIAL_PREFETCHING !== "false",
  cacheLife: {
    // Prerenderable: revalidate > 0, expire >= 5 min. stale inherits the default 5 min.
    "short-revalidate": { revalidate: 10, expire: 3600 },
  },
  ...(useCustomHandler ? { cacheHandlers: { default: require.resolve("./cache-handler.js") } } : {}),
};

export default nextConfig;
