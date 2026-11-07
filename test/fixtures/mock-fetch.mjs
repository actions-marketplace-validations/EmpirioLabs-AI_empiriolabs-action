// Loaded with `node --import` before the entry point: fetch answers with the
// response in MOCK_FETCH and writes the request it received to MOCK_FETCH_LOG,
// so the real src/index.mjs runs end to end without the network.
import { writeFileSync } from "node:fs";

const spec = JSON.parse(process.env.MOCK_FETCH ?? "{}");

globalThis.fetch = async (url, init) => {
  writeFileSync(
    process.env.MOCK_FETCH_LOG,
    JSON.stringify({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
      redirect: init.redirect,
    }),
  );
  return new Response(JSON.stringify(spec.body ?? {}), {
    status: spec.status ?? 200,
    headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
  });
};
