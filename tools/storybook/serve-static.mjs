import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const [rootArg, portArg] = process.argv.slice(2);
if (!rootArg || !portArg) {
  throw new Error("Usage: serve-static.mjs <root> <port>");
}

const root = resolve(process.cwd(), rootArg);
const port = Number(portArg);

const mime = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

createServer(async (request, response) => {
  const rawPath = new URL(request.url ?? "/", "http://localhost").pathname;
  const decoded = decodeURIComponent(rawPath);
  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  let candidate = resolve(root, relative || "index.html");

  if (!candidate.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(candidate);
    if (info.isDirectory()) {
      candidate = join(candidate, "index.html");
    }

    const headers = {
      "content-type": mime.get(extname(candidate)) ?? "application/octet-stream",
      "cache-control": "no-store",
    };

    response.writeHead(200, headers);
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Serving ${root} on http://127.0.0.1:${port}`);
});
