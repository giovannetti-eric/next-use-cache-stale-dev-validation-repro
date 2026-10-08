// One-command reproduction. For each scenario: starts the data server and a fresh
// `next dev`, loads routes on a timed schedule around the 10 s `revalidate` of the
// layout's cached banner, and counts the "encountered uncached data during prerendering"
// errors `next dev` logs after each load.
//
//   node scripts/repro.mjs [scenario ...]     (default: every scenario)
//
// Scenarios:
//   builtin    built-in "use cache" handler; first visit to /other while the banner is stale
//   control    built-in handler; first visit to /other while the banner is still fresh
//   custom     custom handler (./cache-handler.js); reloads of / across two stale hits
//
// Environment, passed through to the app:
//   DATA_DELAY_MS=<ms>          latency of the banner's data source (default 500)
//   PARTIAL_PREFETCHING=false   turn Partial Prefetching off
//   HANDLER_AGE_CHECK=false     custom handler: drop its `expire` check (no clock read in `get`)
//
// Server output lands in results/<next version>_<scenario>.log. Exit code 1 means the
// error was logged in a scenario other than `control`, 0 means it was not, 2 means a run failed.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const root = new URL("..", import.meta.url).pathname;
const port = 3200;
const dataPort = 3201;
const nextVersion = JSON.parse(readFileSync(`${root}node_modules/next/package.json`, "utf8")).version;
const errorPattern = /encountered uncached data during prerendering/;
const settleMs = 2500;

// `at` is in seconds after the first load. The banner revalidates after 10 s.
const scenarios = {
  builtin: {
    handler: "builtin",
    steps: [
      { at: 0, path: "/", note: "banner generated" },
      { at: 3, path: "/", note: "banner fresh hit" },
      { at: 15, path: "/other", note: "banner stale hit, /other data cold" },
      { at: 18, path: "/other", note: "both fresh" },
    ],
  },
  control: {
    handler: "builtin",
    steps: [
      { at: 0, path: "/", note: "banner generated" },
      { at: 3, path: "/other", note: "banner fresh hit, /other data cold" },
      { at: 6, path: "/other", note: "both fresh" },
    ],
  },
  custom: {
    handler: "custom",
    steps: [
      { at: 0, path: "/", note: "banner generated" },
      { at: 3, path: "/", note: "banner fresh hit" },
      { at: 15, path: "/", note: "banner stale hit" },
      { at: 18, path: "/", note: "banner fresh hit" },
      { at: 21, path: "/", note: "banner fresh hit" },
      { at: 45, path: "/", note: "banner stale hit" },
      { at: 48, path: "/", note: "banner fresh hit" },
    ],
  },
};

function waitForExit(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));
}

async function runScenario(name) {
  const { handler, steps } = scenarios[name];
  const label = `${nextVersion}_${name}`;
  mkdirSync(`${root}results`, { recursive: true });
  rmSync(`${root}.next`, { recursive: true, force: true });
  const logFile = createWriteStream(`${root}results/${label}.log`);
  let output = "";

  const children = [];
  function start(command, args, env, prefix) {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, detached: true });
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
    return child;
  }
  async function waitForOutput(pattern, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}`);
      await sleep(100);
    }
  }

  const env = {
    CACHE_HANDLER: handler,
    DATA_URL: `http://127.0.0.1:${dataPort}/`,
    DATA_PORT: String(dataPort),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const rows = [];
  try {
    start("node", ["scripts/data-server.mjs"], env, "[data] ");
    await waitForOutput(/data server listening/, 10_000);
    start(`${root}node_modules/.bin/next`, ["dev", "--port", String(port)], env, "[next] ");
    await waitForOutput(/Ready in/, 60_000);

    console.info(`\n${label}: ${handler} handler`);
    console.info("load  t (s)  path    errors  cache state");
    const t0 = Date.now();
    for (const [index, step] of steps.entries()) {
      const wait = t0 + step.at * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      const before = output.length;
      logFile.write(`===== load ${index + 1} at t=${step.at}s ${step.path} (${step.note}) =====\n`);
      const response = await fetch(`http://127.0.0.1:${port}${step.path}`, { headers: { accept: "text/html" } });
      await response.text();
      if (!response.ok) throw new Error(`${step.path} answered ${response.status}`);
      await sleep(settleMs);
      const errors = output
        .slice(before)
        .split("\n")
        .filter((line) => errorPattern.test(line)).length;
      rows.push(errors);
      console.info(
        `${String(index + 1).padStart(4)}  ${String(step.at).padStart(5)}  ${step.path.padEnd(6)}  ${String(errors).padStart(6)}  ${step.note}`,
      );
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
  return { label, nextVersion, scenario: name, handler, errors: rows.reduce((a, b) => a + b, 0), perLoad: rows };
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(scenarios);
let reproduced = false;
try {
  for (const name of names) {
    if (!scenarios[name]) throw new Error(`unknown scenario ${name}`);
    const result = await runScenario(name);
    console.info(`RESULT ${JSON.stringify(result)}`);
    if (result.errors > 0 && name !== "control") reproduced = true;
  }
  console.info(reproduced ? "\nREPRODUCED" : "\nNOT REPRODUCED");
  process.exitCode = reproduced ? 1 : 0;
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
