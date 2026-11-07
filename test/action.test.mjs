import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { API_URL, ATTEMPTS, USER_AGENT, escapeData, getInput, main, redact } from "../src/action.mjs";
import { KEY, completion, mockFetch, readOutputs, runnerEnv } from "./helpers.mjs";

/** Runs the action on these inputs against a mocked API. */
async function run(inputs = {}, { responses = [], extra = {}, prepare } = {}) {
  const { env, dir, output } = runnerEnv(inputs, extra);
  prepare?.(dir, env);
  const fetch = mockFetch(...responses);
  const sleeps = [];
  let stdout = "";
  const code = await main({
    env,
    fetch,
    write: (text) => {
      stdout += text;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { code, stdout, outputs: readOutputs(output), calls: fetch.calls, sleeps };
}

function errorLine(stdout) {
  return stdout.split(/\r?\n/).find((line) => line.startsWith("::error"));
}

describe("inputs", () => {
  test("are read the way the runner names them", () => {
    const env = { "INPUT_API-KEY": "  key  ", "INPUT_MAX-TOKENS": "5", "INPUT_PROMPT-FILE": "a.txt", INPUT_A_B: "x" };
    assert.equal(getInput(env, "api-key"), "key");
    assert.equal(getInput(env, "max-tokens"), "5");
    assert.equal(getInput(env, "prompt-file"), "a.txt");
    assert.equal(getInput(env, "a b"), "x");
    assert.equal(getInput(env, "missing"), "");
  });

  test("api-key and model are required, and the request is never sent without them", async () => {
    const noKey = await run({ "api-key": undefined, prompt: "Hi" });
    assert.equal(noKey.code, 1);
    assert.match(errorLine(noKey.stdout), /api-key is required\. Create an API key at https:\/\/platform\.empiriolabs\.ai\/dashboard\/api-keys/);
    assert.equal(noKey.calls.length, 0);

    const noModel = await run({ model: "  ", prompt: "Hi" });
    assert.equal(noModel.code, 1);
    assert.match(errorLine(noModel.stdout), /model is required\. Set it to a model ID from https:\/\/docs\.empiriolabs\.ai\/models-pricing/);
    assert.equal(noModel.calls.length, 0);
  });

  test("something to send is required", async () => {
    const result = await run({});
    assert.equal(result.code, 1);
    assert.match(errorLine(result.stdout), /Set prompt, prompt-file, or messages\./);
    assert.equal(result.calls.length, 0);
  });

  test("max-tokens must be a whole number greater than 0", async () => {
    for (const value of ["0", "-1", "1.5", "abc", "1e3", "12 tokens"]) {
      const result = await run({ prompt: "Hi", "max-tokens": value });
      assert.equal(result.code, 1, value);
      assert.match(errorLine(result.stdout), /max-tokens must be a whole number greater than 0\./, value);
      assert.equal(result.calls.length, 0, value);
    }
  });

  test("temperature must be a number of 0 or more", async () => {
    for (const value of ["hot", "-1", "1e-1", "0x1", "1,5"]) {
      const result = await run({ prompt: "Hi", temperature: value });
      assert.equal(result.code, 1, value);
      assert.match(errorLine(result.stdout), /temperature must be a number of 0 or more/, value);
      assert.equal(result.calls.length, 0, value);
    }
    for (const [value, expected] of [["0", 0], ["2", 2], ["0.25", 0.25], [".5", 0.5]]) {
      const result = await run({ prompt: "Hi", temperature: value });
      assert.equal(result.code, 0, value);
      assert.equal(result.calls[0].body.temperature, expected, value);
    }
  });
});

describe("the request", () => {
  test("is one chat completion with the key, the model, the messages, and the settings", async () => {
    const result = await run({ prompt: "Say hi", system: "Be brief", "max-tokens": "64", temperature: "0.2" });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.calls.length, 1);
    const [{ url, init, body }] = result.calls;
    assert.equal(url, API_URL);
    assert.equal(url, "https://api.empiriolabs.ai/v1/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.headers["User-Agent"], USER_AGENT);
    assert.deepEqual(body, {
      model: "test-model",
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Say hi" },
      ],
      max_tokens: 64,
      temperature: 0.2,
    });
  });

  test("leaves max_tokens and temperature to the model when they are not set", async () => {
    const result = await run({ prompt: "Hi" });
    assert.deepEqual(result.calls[0].body, { model: "test-model", messages: [{ role: "user", content: "Hi" }] });
  });

  test("prompt-file is read from the workspace and sent after prompt", async () => {
    const diff = "diff --git a/x b/x\n+added line\n";
    const both = await run(
      { prompt: "Summarize this diff.", "prompt-file": "changes.diff" },
      { prepare: (dir) => writeFileSync(join(dir, "changes.diff"), diff) },
    );
    assert.equal(both.code, 0, both.stdout);
    assert.deepEqual(both.calls[0].body.messages, [{ role: "user", content: `Summarize this diff.\n\n${diff}` }]);

    let absolute;
    const alone = await run(
      {},
      {
        prepare: (dir, env) => {
          absolute = join(dir, "notes.md");
          writeFileSync(absolute, "# Notes\n");
          env["INPUT_PROMPT-FILE"] = absolute;
        },
      },
    );
    assert.equal(alone.code, 0, alone.stdout);
    assert.deepEqual(alone.calls[0].body.messages, [{ role: "user", content: "# Notes\n" }]);
  });

  test("a missing or empty prompt-file fails before the request", async () => {
    const missing = await run({ "prompt-file": "nope.txt" });
    assert.equal(missing.code, 1);
    assert.match(errorLine(missing.stdout), /Could not read prompt-file nope\.txt: the file does not exist\./);
    assert.equal(missing.calls.length, 0);

    const empty = await run({ prompt: "Summarize:", "prompt-file": "empty.txt" }, { prepare: (dir) => writeFileSync(join(dir, "empty.txt"), " \n") });
    assert.equal(empty.code, 1);
    assert.match(errorLine(empty.stdout), /prompt-file empty\.txt is empty\./);
    assert.equal(empty.calls.length, 0);
  });

  test("messages sends the whole conversation, after system", async () => {
    const messages = [
      { role: "user", content: "Name a color." },
      { role: "assistant", content: "Blue." },
      { role: "user", content: [{ type: "text", text: "Another one." }] },
    ];
    const result = await run({ messages: JSON.stringify(messages, null, 2), system: "One word answers." });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.calls[0].body.messages, [{ role: "system", content: "One word answers." }, ...messages]);
  });

  test("messages must be a JSON array of messages, and its content is never echoed", async () => {
    const cases = [
      ['[{"role": "user", "content": "top secret plan"', /messages is not valid JSON/],
      ['{"role": "user", "content": "top secret plan"}', /messages must be a JSON array/],
      ["[]", /messages must be a JSON array/],
      ['[{"content": "top secret plan"}]', /messages\[0\] must be an object with a role and content\./],
      ['[{"role": "user", "content": "x"}, {"role": "user"}]', /messages\[1\] must be an object with a role and content\./],
      ['["top secret plan"]', /messages\[0\] must be an object/],
    ];
    for (const [value, expected] of cases) {
      const result = await run({ messages: value });
      assert.equal(result.code, 1, value);
      assert.match(errorLine(result.stdout), expected, value);
      assert.ok(!result.stdout.includes("top secret plan"), value);
      assert.equal(result.calls.length, 0, value);
    }
  });

  test("messages cannot be combined with prompt or prompt-file", async () => {
    for (const extra of [{ prompt: "Hi" }, { "prompt-file": "a.txt" }]) {
      const result = await run({ messages: '[{"role": "user", "content": "Hi"}]', ...extra });
      assert.equal(result.code, 1);
      assert.match(errorLine(result.stdout), /Set messages, or prompt and prompt-file, but not both\./);
      assert.equal(result.calls.length, 0);
    }
  });
});

describe("the reply", () => {
  test("becomes the text, usage, and finish-reason outputs", async () => {
    const result = await run({ prompt: "Hi" }, { responses: [{ body: completion("Hello there.") }] });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.outputs.text, "Hello there.");
    assert.deepEqual(JSON.parse(result.outputs.usage), { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
    assert.equal(result.outputs["finish-reason"], "stop");
    assert.match(result.stdout, /Requesting a reply from test-model\./);
    assert.match(result.stdout, /Received a reply of 12 characters \(finish reason: stop\)\./);
    assert.match(result.stdout, /Usage: 9 prompt tokens, 2 completion tokens, 11 total tokens\./);
  });

  test("keeps a multiline reply intact", async () => {
    const text = "## Summary\n\n- first\n- second\n\nDone.";
    const result = await run({ prompt: "Hi" }, { responses: [{ body: completion(text) }] });
    assert.equal(result.outputs.text, text);
  });

  test("joins a reply given as content parts", async () => {
    const parts = [{ type: "text", text: "Hello, " }, { type: "text", text: "world." }];
    const result = await run({ prompt: "Hi" }, { responses: [{ body: completion(parts) }] });
    assert.equal(result.outputs.text, "Hello, world.");
  });

  test("is read after leading whitespace in the body", async () => {
    const body = `   \n   ${JSON.stringify(completion("Late answer."))}`;
    const result = await run({ prompt: "Hi" }, { responses: [{ body }] });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.outputs.text, "Late answer.");
  });

  test("an empty usage is an empty output", async () => {
    const result = await run({ prompt: "Hi" }, { responses: [{ body: completion("Hi.", { usage: null }) }] });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.outputs.usage, "");
    assert.ok(!result.stdout.includes("Usage:"));
  });

  test("a reply cut off at the token limit succeeds with a warning", async () => {
    const result = await run({ prompt: "Hi", "max-tokens": "5" }, { responses: [{ body: completion("Once upon", { finishReason: "length" }) }] });
    assert.equal(result.code, 0);
    assert.equal(result.outputs["finish-reason"], "length");
    assert.match(result.stdout, /^::warning title=EmpirioLabs AI::The reply stopped at the token limit before it was complete\. Raise max-tokens for a longer reply\.$/m);
  });

  test("an empty reply succeeds with a warning", async () => {
    const result = await run({ prompt: "Hi" }, { responses: [{ body: completion(null) }] });
    assert.equal(result.code, 0);
    assert.equal(result.outputs.text, "");
    assert.match(result.stdout, /^::warning title=EmpirioLabs AI::The model returned an empty reply\.$/m);
  });

  test("prompts and replies never reach the log", async () => {
    const result = await run({ prompt: "PROMPT-MARKER", system: "SYSTEM-MARKER" }, { responses: [{ body: completion("REPLY-MARKER") }] });
    assert.equal(result.code, 0);
    for (const marker of ["PROMPT-MARKER", "SYSTEM-MARKER", "REPLY-MARKER"]) {
      assert.ok(!result.stdout.includes(marker), marker);
    }
  });

  test("a response that is not JSON, or has no reply, fails", async () => {
    for (const [body, expected] of [
      ["not json", /returned a response that is not valid JSON\./],
      ["", /returned a response that is not valid JSON\./],
      [{ choices: [] }, /returned a response without a reply\./],
      [{ object: "chat.completion" }, /returned a response without a reply\./],
    ]) {
      const result = await run({ prompt: "Hi" }, { responses: [{ body }] });
      assert.equal(result.code, 1, JSON.stringify(body));
      assert.match(errorLine(result.stdout), expected, JSON.stringify(body));
      assert.deepEqual(result.outputs, {});
    }
  });
});

describe("API errors", () => {
  const apiError = (message, code, type = "invalid_request_error") => ({
    error: { message, type, param: null, code, request_id: "req_test_1" },
  });

  test("fail with the API's message, its code, a hint, and the request ID", async () => {
    const result = await run({ prompt: "Hi" }, {
      responses: [{ status: 401, body: apiError("The API key is invalid, inactive, or expired.", "invalid_api_key") }],
    });
    assert.equal(result.code, 1);
    assert.equal(
      errorLine(result.stdout),
      "::error title=EmpirioLabs AI::EmpirioLabs AI API error (HTTP 401, invalid_api_key): The API key is invalid, inactive, or expired. " +
        "Check the API key. Keys are managed at https://platform.empiriolabs.ai/dashboard/api-keys. Request ID: req_test_1",
    );
    assert.deepEqual(result.outputs, {});
    assert.equal(result.calls.length, 1);
  });

  test("point to credits and model IDs where they help", async () => {
    const credits = await run({ prompt: "Hi" }, {
      responses: [{ status: 402, body: apiError("Insufficient credits. Top up your balance to continue.", "insufficient_credits", "insufficient_quota") }],
    });
    assert.match(errorLine(credits.stdout), /\(HTTP 402, insufficient_credits\): Insufficient credits\. Top up your balance to continue\. Add credits at https:\/\/platform\.empiriolabs\.ai\/dashboard\/billing/);

    const model = await run({ prompt: "Hi" }, { responses: [{ status: 404, body: apiError("Model not found.", "model_not_found") }] });
    assert.match(errorLine(model.stdout), /\(HTTP 404, model_not_found\): Model not found\. Check the model ID\. Model IDs are listed at https:\/\/docs\.empiriolabs\.ai\/models-pricing/);
  });

  test("an error body after a 200 fails", async () => {
    const result = await run({ prompt: "Hi" }, {
      responses: [{ status: 200, body: apiError("The request did not complete within 15 minutes. Please try again.", "timeout", "server_error") }],
    });
    assert.equal(result.code, 1);
    assert.match(errorLine(result.stdout), /EmpirioLabs AI API error \(timeout\): The request did not complete within 15 minutes\. Please try again\. Request ID: req_test_1$/);
  });

  test("a body that is not JSON still gives the status", async () => {
    const result = await run({ prompt: "Hi" }, { responses: [{ status: 502, body: "upstream error", headers: { "content-type": "text/plain", "x-request-id": "req_hdr" } }] });
    assert.match(errorLine(result.stdout), /EmpirioLabs AI API error \(HTTP 502\): upstream error\. Request ID: req_hdr$/);
    const html = await run({ prompt: "Hi" }, { responses: [{ status: 503, body: "<html><body>Service Unavailable</body></html>", headers: { "content-type": "text/html" } }] });
    assert.match(errorLine(html.stdout), /EmpirioLabs AI API error \(HTTP 503\): Service Unavailable$/);
  });

  test("a 429 is sent again after Retry-After, then succeeds", async () => {
    const result = await run({ prompt: "Hi" }, {
      responses: [
        { status: 429, body: apiError("Account request rate limit exceeded. Please slow down.", "rate_limit_exceeded", "requests"), headers: { "retry-after": "2" } },
        { body: completion("Hello") },
      ],
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.sleeps, [2000]);
    assert.match(result.stdout, /rate limit reached\. Trying again in 2 s \(attempt 2 of 3\)\./);
    assert.equal(result.outputs.text, "Hello");
  });

  test("a 429 stops after the last attempt", async () => {
    const result = await run({ prompt: "Hi" }, {
      responses: [{ status: 429, body: apiError("Account request rate limit exceeded. Please slow down.", "rate_limit_exceeded", "requests") }],
    });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, ATTEMPTS);
    assert.deepEqual(result.sleeps, [2000, 4000]);
    assert.match(errorLine(result.stdout), /\(HTTP 429, rate_limit_exceeded\): Account request rate limit exceeded\. Please slow down\. Too many requests right now/);
  });

  test("a server error is not sent again", async () => {
    const result = await run({ prompt: "Hi" }, { responses: [{ status: 500, body: apiError("Internal server error.", null, "server_error") }] });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.match(errorLine(result.stdout), /EmpirioLabs AI API error \(HTTP 500, server_error\): Internal server error\./);
  });

  test("a network failure is not sent again, and says the request may have been processed", async () => {
    const failure = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.empiriolabs.ai") });
    const result = await run({ prompt: "Hi" }, { responses: [failure] });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.match(errorLine(result.stdout), /The request to EmpirioLabs AI failed: getaddrinfo ENOTFOUND api\.empiriolabs\.ai\. It may still have been processed/);
  });

  test("a redirect is refused", async () => {
    const result = await run({ prompt: "Hi" }, { responses: [new TypeError("fetch failed", { cause: new Error("unexpected redirect") })] });
    assert.equal(result.code, 1);
    assert.match(errorLine(result.stdout), /answered with a redirect, which a request that carries the API key does not follow\./);
  });
});

describe("the log", () => {
  test("masks the key on the runner, and prints it nowhere else", async () => {
    const onRunner = await run({ prompt: "Hi" }, { extra: { GITHUB_ACTIONS: "true" } });
    const lines = onRunner.stdout.split(/\r?\n/);
    assert.equal(lines[0], `::add-mask::${KEY}`);
    assert.equal(lines.filter((line) => line.includes(KEY)).length, 1);

    const local = await run({ prompt: "Hi" });
    assert.ok(!local.stdout.includes(KEY));
  });

  test("removes the key, and anything shaped like a key, from error messages", async () => {
    const result = await run({ prompt: "Hi" }, {
      responses: [{ status: 400, body: { error: { message: `Bad key ${KEY} or sk-empiriolabs-other_Key-123`, type: "invalid_request_error" } } }],
    });
    assert.equal(result.code, 1);
    assert.ok(!result.stdout.includes(KEY));
    assert.ok(!result.stdout.includes("other_Key-123"));
    assert.match(errorLine(result.stdout), /Bad key \*\*\* or sk-empiriolabs-\*\*\*/);
  });

  test("a model ID cannot start a workflow command", async () => {
    const result = await run({ model: "test-model\n::error::injected", prompt: "Hi" });
    assert.equal(result.code, 0);
    assert.ok(!/^\s*::error::injected/m.test(result.stdout));
    assert.match(result.stdout, /Requesting a reply from test-model ::error::injected\./);
  });

  test("an error with a line break stays one workflow command", async () => {
    const result = await run({ prompt: "Hi" }, {
      responses: [{ status: 400, body: { error: { message: "first line\n::error::second 100%", type: "invalid_request_error" } } }],
    });
    assert.equal(result.stdout.split(/\r?\n/).filter((line) => line.startsWith("::error")).length, 1);
    assert.match(errorLine(result.stdout), /first line%0A::error::second 100%25/);
  });

  test("fails before any request when GITHUB_OUTPUT is not set", async () => {
    const { env } = runnerEnv({ prompt: "Hi" });
    delete env.GITHUB_OUTPUT;
    const fetch = mockFetch();
    let stdout = "";
    const code = await main({ env, fetch, write: (text) => (stdout += text) });
    assert.equal(code, 1);
    assert.equal(fetch.calls.length, 0);
    assert.match(stdout, /GITHUB_OUTPUT is not set/);
  });
});

describe("helpers", () => {
  test("redact", () => {
    assert.equal(redact("a sk-empiriolabs-abc_DEF-123 b"), "a sk-empiriolabs-*** b");
    assert.equal(redact("key=supersecretvalue", ["supersecretvalue"]), "key=***");
    assert.equal(redact("short", ["abc"]), "short");
  });

  test("escapeData", () => {
    assert.equal(escapeData("100%\r\nnext"), "100%25%0D%0Anext");
  });
});
