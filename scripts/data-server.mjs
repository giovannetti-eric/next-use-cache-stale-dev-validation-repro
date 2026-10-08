// Data source for the "use cache" functions. Answers every request with the time it was
// served, after `?delay=<ms>` or DATA_DELAY_MS (default 500 ms), to stand in for a real API.
import { createServer } from "node:http";

const port = Number(process.env.DATA_PORT ?? 3201);
const defaultDelayMs = Number(process.env.DATA_DELAY_MS ?? 500);
let requests = 0;

createServer((request, response) => {
  const id = ++requests;
  const delayMs = Number(new URL(request.url, "http://localhost").searchParams.get("delay") ?? defaultDelayMs);
  console.info(`data request #${id} ${request.method} ${request.url} received`);
  setTimeout(() => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ servedAt: new Date().toISOString() }));
    console.info(`data request #${id} answered after ${delayMs} ms`);
  }, delayMs);
}).listen(port, "127.0.0.1", () => {
  console.info(`data server listening on http://127.0.0.1:${port}/ (default delay ${defaultDelayMs} ms)`);
});
