// Data source for the "use cache" functions. Answers every request with a version number,
// counted per `?source=`, and the time it was served, after `?delay=<ms>` or DATA_DELAY_MS
// (default 500 ms), to stand in for a real API.
import { createServer } from "node:http";

const port = Number(process.env.DATA_PORT ?? 3201);
const defaultDelayMs = Number(process.env.DATA_DELAY_MS ?? 500);
let requests = 0;
const versions = new Map();

createServer((request, response) => {
  const id = ++requests;
  const params = new URL(request.url, "http://localhost").searchParams;
  const delayMs = Number(params.get("delay") ?? defaultDelayMs);
  const source = params.get("source") ?? "default";
  const version = (versions.get(source) ?? 0) + 1;
  versions.set(source, version);
  console.info(`data request #${id} ${request.method} ${request.url} received, version ${version}`);
  setTimeout(() => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version, servedAt: new Date().toISOString() }));
    console.info(`data request #${id} answered after ${delayMs} ms`);
  }, delayMs);
}).listen(port, "127.0.0.1", () => {
  console.info(`data server listening on http://127.0.0.1:${port}/ (default delay ${defaultDelayMs} ms)`);
});
