// Runs src/index.mjs the way the runner does, as its own Node.js process with
// the inputs in INPUT_* variables, with fetch answered by fixtures/mock-fetch.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { KEY, completion, readOutputs, runnerEnv } from "./helpers.mjs";

const ENTRY = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
const MOCK = pathToFileURL(fileURLToPath(new URL("./fixtures/mock-fetch.mjs", import.meta.url))).href;

function runEntry(inputs, response, extra = {}) {
  const { env, dir, output } = runnerEnv(inputs, extra);
  const log = join(dir, "request.json");
  // The runner's own variables come only from runnerEnv, never from the process running the tests.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(INPUT_|GITHUB_|RUNNER_)/i.test(name) && name !== "NODE_OPTIONS"),
  );
  const child = spawnSync(process.execPath, ["--import", MOCK, ENTRY], {
    env: { ...inherited, ...env, MOCK_FETCH: JSON.stringify(response), MOCK_FETCH_LOG: log },
    encoding: "utf8",
  });
  return { child, outputs: readOutputs(output), request: () => JSON.parse(readFileSync(log, "utf8")) };
}

test("the entry point sends the request, writes the outputs, and exits 0", () => {
  const { child, outputs, request } = runEntry(
    { prompt: "Write a haiku.", "max-tokens": "100" },
    { body: completion("Autumn moonlight\na worm digs silently\ninto the chestnut.") },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(child.stderr, "");
  assert.equal(outputs.text, "Autumn moonlight\na worm digs silently\ninto the chestnut.");
  assert.equal(outputs["finish-reason"], "stop");
  assert.equal(JSON.parse(outputs.usage).total_tokens, 11);
  const sent = request();
  assert.equal(sent.url, "https://api.empiriolabs.ai/v1/chat/completions");
  assert.equal(sent.method, "POST");
  assert.equal(sent.redirect, "error");
  assert.equal(sent.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(sent.body, { model: "test-model", messages: [{ role: "user", content: "Write a haiku." }], max_tokens: 100 });
  assert.ok(!child.stdout.includes(KEY));
});

test("the entry point exits 1 with an error annotation when the API refuses the key", () => {
  const { child, outputs } = runEntry(
    { prompt: "Hi" },
    {
      status: 401,
      body: { error: { message: "The API key is invalid, inactive, or expired.", type: "invalid_request_error", code: "invalid_api_key" } },
    },
    { GITHUB_ACTIONS: "true" },
  );
  assert.equal(child.status, 1, child.stdout + child.stderr);
  const lines = child.stdout.split(/\r?\n/);
  assert.equal(lines[0], `::add-mask::${KEY}`);
  assert.ok(lines.some((line) => line.startsWith("::error title=EmpirioLabs AI::EmpirioLabs AI API error (HTTP 401, invalid_api_key)")));
  assert.deepEqual(outputs, {});
});
