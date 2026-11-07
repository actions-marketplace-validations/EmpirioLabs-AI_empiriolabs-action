import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A made-up key, shaped like a real one so the redaction of key-shaped text is tested too. */
export const KEY = "sk-empiriolabs-test0123456789abcdefTEST";

const created = [];
process.on("exit", () => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A new temporary directory, removed when the test process exits. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "empiriolabs-action-"));
  created.push(dir);
  return dir;
}

/** The environment the runner gives the action for these inputs, with an empty GITHUB_OUTPUT file. */
export function runnerEnv(inputs = {}, extra = {}) {
  const dir = tempDir();
  const output = join(dir, "github-output.txt");
  writeFileSync(output, "");
  const env = { GITHUB_OUTPUT: output, GITHUB_WORKSPACE: dir, ...extra };
  for (const [name, value] of Object.entries({ "api-key": KEY, model: "test-model", ...inputs })) {
    if (value !== undefined) {
      env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
    }
  }
  return { env, dir, output };
}

/** Reads a GITHUB_OUTPUT file the way the runner does: name<<delimiter, the value, the delimiter. */
export function readOutputs(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const outputs = {};
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]) {
      continue;
    }
    const heredoc = /^([^<=]+)<<(.+)$/.exec(lines[i]);
    if (!heredoc) {
      throw new Error(`unexpected line in GITHUB_OUTPUT: ${lines[i]}`);
    }
    const [, name, delimiter] = heredoc;
    const value = [];
    for (i += 1; i < lines.length && lines[i] !== delimiter; i += 1) {
      value.push(lines[i]);
    }
    if (i >= lines.length) {
      throw new Error(`the ${name} output has no closing delimiter`);
    }
    outputs[name] = value.join("\n");
  }
  return outputs;
}

/** A chat completion body as the API returns it. */
export function completion(content, { finishReason = "stop", usage = { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } } = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1790000000,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * A fetch that answers with the given responses in turn (the last one repeats)
 * and records every call. A response is { status, body, headers }, or an Error
 * to throw.
 */
export function mockFetch(...responses) {
  const queue = responses.length ? [...responses] : [{ body: completion("Hello") }];
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) {
      throw next;
    }
    const { status = 200, body = completion("Hello"), headers = {} } = next;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  fetch.calls = calls;
  return fetch;
}
