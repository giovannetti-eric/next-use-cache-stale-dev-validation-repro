// Production check: does a stale "use cache" hit change what the embedded runtime prefetch
// (Partial Prefetching) contains? For each scenario: starts the data server, runs
// `next build` and `next start`, requests /dynamic on a timed schedule around the 10 s
// `revalidate` of its cached greeting, and counts the copies of the greeting in each response.
//
//   node scripts/prod.mjs [scenario ...]     (default: every scenario)
//
// Scenarios:
//   custom          custom handler (serves stale entries until `expire`), partialPrefetching on
//   custom-no-pp    custom handler, partialPrefetching off (no runtime prefetch)
//   builtin         built-in handler (drops entries at `revalidate` in production)
//
// /dynamic renders the greeting after a cookie read, inside <Suspense>, so every request
// reads it from the cache handler. A document response carries the greeting in the HTML,
// in the inline RSC payload and, with partialPrefetching, in the embedded runtime prefetch:
// 3 copies. An RSC navigation response carries 2 (payload and runtime prefetch). Without
// partialPrefetching, one copy less each.
//
// Server output lands in results/<next version>_prod-<scenario>.log. Exit code 1 means a
// response carried fewer greeting copies than the fresh responses of the same scenario.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const root = new URL("..", import.meta.url).pathname;
const port = 3200;
const dataPort = 3201;
const nextVersion = JSON.parse(readFileSync(`${root}node_modules/next/package.json`, "utf8")).version;
const rsc = { RSC: "1" };

const scenarios = {
  custom: { handler: "custom", partialPrefetching: "true" },
  "custom-no-pp": { handler: "custom", partialPrefetching: "false" },
  builtin: { handler: "builtin", partialPrefetching: "true" },
};

// `at` is in seconds after the first request. The greeting revalidates after 10 s.
const steps = [
  { at: 0, kind: "document", headers: {}, note: "greeting cold: generated during the request" },
  { at: 3, kind: "document", headers: {}, note: "greeting fresh" },
  { at: 15, kind: "document", headers: {}, note: "greeting stale: served, regenerated in background" },
  { at: 18, kind: "document", headers: {}, note: "greeting fresh (regenerated)" },
  { at: 30, kind: "rsc", headers: rsc, note: "greeting stale: served, regenerated in background" },
  { at: 33, kind: "rsc", headers: rsc, note: "greeting fresh (regenerated)" },
];

function waitForExit(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));
}

async function runScenario(name) {
  const { handler, partialPrefetching } = scenarios[name];
  const label = `${nextVersion}_prod-${name}`;
  mkdirSync(`${root}results`, { recursive: true });
  rmSync(`${root}.next`, { recursive: true, force: true });
  const logFile = createWriteStream(`${root}results/${label}.log`);
  let output = "";

  const env = {
    ...process.env,
    CACHE_HANDLER: handler,
    PARTIAL_PREFETCHING: partialPrefetching,
    DATA_URL: `http://127.0.0.1:${dataPort}/`,
    DATA_PORT: String(dataPort),
    HANDLER_LOG: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const children = [];
  function start(command, args, prefix) {
    const child = spawn(command, args, { cwd: root, env, detached: true });
    let pending = "";
    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) logFile.write(`${prefix}${line}\n`);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    children.push(child);
  }
  async function waitForOutput(pattern, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}`);
      await sleep(100);
    }
  }

  const rows = [];
  try {
    start("node", ["scripts/data-server.mjs"], "[data] ");
    await waitForOutput(/data server listening/, 10_000);
    const build = spawnSync(`${root}node_modules/.bin/next`, ["build"], { cwd: root, env, encoding: "utf8" });
    logFile.write(build.stdout.replace(/^/gm, "[build] ") + build.stderr.replace(/^/gm, "[build] "));
    if (build.status !== 0) throw new Error(`next build failed, see results/${label}.log`);
    start(`${root}node_modules/.bin/next`, ["start", "--port", String(port)], "[next] ");
    await waitForOutput(/Ready in/, 60_000);

    console.info(`\n${label}: ${handler} handler, partialPrefetching ${partialPrefetching}`);
    console.info("req  t (s)  kind      ms  greeting copies (version: count)  state");
    const t0 = Date.now();
    for (const [index, step] of steps.entries()) {
      const wait = t0 + step.at * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      logFile.write(`===== request ${index + 1} at t=${step.at}s ${step.kind} (${step.note}) =====\n`);
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/dynamic`, { headers: step.headers });
      const body = await response.text();
      const ms = Date.now() - started;
      if (!response.ok) throw new Error(`/dynamic answered ${response.status}`);
      const copies = {};
      for (const match of body.matchAll(/Greeting data version (\d+)/g)) copies[match[1]] = (copies[match[1]] ?? 0) + 1;
      const total = Object.values(copies).reduce((a, b) => a + b, 0);
      rows.push({ request: index + 1, at: step.at, kind: step.kind, ms, copies, total });
      const summary = Object.entries(copies)
        .map(([version, count]) => `v${version}: ${count}`)
        .join(", ");
      console.info(
        `${String(index + 1).padStart(3)}  ${String(step.at).padStart(5)}  ${step.kind.padEnd(8)} ${String(ms).padStart(4)}  ${`${total} (${summary})`.padEnd(32)}  ${step.note}`,
      );
      await sleep(1500);
    }
  } finally {
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
    await Promise.all(children.map(waitForExit));
    logFile.end();
  }

  // A response is short when it carries fewer copies than the largest count seen for its kind.
  const expected = {};
  for (const row of rows) expected[row.kind] = Math.max(expected[row.kind] ?? 0, row.total);
  const short = rows.filter((row) => row.total < expected[row.kind]).map((row) => row.request);
  return { label, nextVersion, scenario: name, handler, partialPrefetching, short, rows };
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(scenarios);
let impacted = false;
try {
  for (const name of names) {
    if (!scenarios[name]) throw new Error(`unknown scenario ${name}`);
    const result = await runScenario(name);
    console.info(`PROD_RESULT ${JSON.stringify(result)}`);
    if (result.short.length > 0) impacted = true;
  }
  console.info(impacted ? "\nRUNTIME PREFETCH INCOMPLETE ON A STALE HIT" : "\nNO DIFFERENCE");
  process.exitCode = impacted ? 1 : 0;
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
