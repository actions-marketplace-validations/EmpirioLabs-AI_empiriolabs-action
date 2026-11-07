// The EmpirioLabs AI action: one chat completion per step.
//
// It uses only Node.js itself (fetch and the standard library), so the runner
// runs exactly the code in this repository, with no build step and no
// dependency. index.mjs is the entry point; everything here is exported for
// the tests, which pass their own environment, fetch, and output writer.

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { STATUS_CODES } from "node:http";
import { EOL } from "node:os";
import { resolve } from "node:path";

/** Kept equal to the release tag without its "v"; the release workflow checks it. */
export const VERSION = "1.0.0";
export const API_URL = "https://api.empiriolabs.ai/v1/chat/completions";
export const USER_AGENT = `empiriolabs-action/${VERSION}`;

const BRAND = "EmpirioLabs AI";
const API_KEYS_URL = "https://platform.empiriolabs.ai/dashboard/api-keys";
const BILLING_URL = "https://platform.empiriolabs.ai/dashboard/billing";
const MODELS_URL = "https://docs.empiriolabs.ai/models-pricing";

/**
 * Attempts in all when the API answers 429. Nothing else is sent again: a
 * request that failed after it was sent may still have been processed and
 * billed.
 */
export const ATTEMPTS = 3;

const HINTS = {
  401: `Check the API key. Keys are managed at ${API_KEYS_URL}.`,
  402: `Add credits at ${BILLING_URL}, then run the job again.`,
  404: `Check the model ID. Model IDs are listed at ${MODELS_URL}.`,
  413: "The input is too large.",
  429: "Too many requests right now. Wait a moment, then run the job again.",
};

const KEY_SHAPE = /sk-empiriolabs-[A-Za-z0-9_-]+/g;

/** A failure with a message written for the person reading the workflow log. */
export class ActionError extends Error {}

/** An input as the runner passes it: INPUT_ and the name in capitals, spaces as underscores, trimmed. */
export function getInput(env, name) {
  const value = env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return typeof value === "string" ? value.trim() : "";
}

/** Reads and checks the inputs, and returns the API key, the model, and the request body. */
export function readRequest(env, readFile = readFileSync) {
  const apiKey = getInput(env, "api-key");
  if (!apiKey) {
    throw new ActionError(
      `api-key is required. Create an API key at ${API_KEYS_URL}, save it as a secret such as EMPIRIOLABS_API_KEY, and pass it as api-key.`,
    );
  }
  const model = getInput(env, "model");
  if (!model) {
    throw new ActionError(`model is required. Set it to a model ID from ${MODELS_URL}.`);
  }

  const prompt = getInput(env, "prompt");
  const promptFile = getInput(env, "prompt-file");
  const messagesInput = getInput(env, "messages");
  let messages;
  if (messagesInput) {
    if (prompt || promptFile) {
      throw new ActionError("Set messages, or prompt and prompt-file, but not both.");
    }
    messages = parseMessages(messagesInput);
  } else {
    let content = prompt;
    if (promptFile) {
      const text = readPromptFile(env, promptFile, readFile);
      if (!text.trim()) {
        throw new ActionError(`prompt-file ${promptFile} is empty.`);
      }
      content = content ? `${content}\n\n${text}` : text;
    }
    if (!content) {
      throw new ActionError("Set prompt, prompt-file, or messages.");
    }
    messages = [{ role: "user", content }];
  }
  const system = getInput(env, "system");
  if (system) {
    messages = [{ role: "system", content: system }, ...messages];
  }

  const body = { model, messages };
  const maxTokens = getInput(env, "max-tokens");
  if (maxTokens) {
    if (!/^[1-9][0-9]*$/.test(maxTokens) || !Number.isSafeInteger(Number(maxTokens))) {
      throw new ActionError("max-tokens must be a whole number greater than 0.");
    }
    body.max_tokens = Number(maxTokens);
  }
  const temperature = getInput(env, "temperature");
  if (temperature) {
    if (!/^([0-9]+(\.[0-9]+)?|\.[0-9]+)$/.test(temperature)) {
      throw new ActionError("temperature must be a number of 0 or more, such as 0.2.");
    }
    body.temperature = Number(temperature);
  }
  return { apiKey, model, body };
}

function readPromptFile(env, path, readFile) {
  const full = resolve(env.GITHUB_WORKSPACE || process.cwd(), path);
  try {
    return readFile(full, "utf8");
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "the file does not exist" : describe(error);
    throw new ActionError(`Could not read prompt-file ${path}: ${reason}.`);
  }
}

function parseMessages(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // The parser's own message can quote the input, so only its position is kept.
    const at = /position ([0-9]+)/.exec(String(error?.message));
    throw new ActionError(`messages is not valid JSON${at ? ` (at character ${at[1]})` : ""}.`);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ActionError("messages must be a JSON array of one or more messages, each with a role and content.");
  }
  value.forEach((message, index) => {
    if (!isRecord(message) || typeof message.role !== "string" || !message.role || !("content" in message)) {
      throw new ActionError(`messages[${index}] must be an object with a role and content.`);
    }
  });
  return value;
}

/**
 * Sends the chat completion and returns the parsed response body. A 429 is
 * tried again after the time the API asks for; any other failure is thrown.
 */
export async function requestReply({ apiKey, body }, { fetch, sleep, log }) {
  const init = {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
    // A request that carries the API key never follows a redirect.
    redirect: "error",
  };
  for (let attempt = 1; ; attempt += 1) {
    let response;
    let text;
    try {
      response = await fetch(API_URL, init);
      text = await response.text();
    } catch (error) {
      const reason = describe(error);
      if (/redirect/i.test(reason)) {
        throw new ActionError(`${BRAND} answered with a redirect, which a request that carries the API key does not follow.`);
      }
      throw new ActionError(
        `The request to ${BRAND} failed: ${reason}. It may still have been processed, so check before running the job again.`,
      );
    }
    if (response.status === 429 && attempt < ATTEMPTS) {
      const seconds = retryAfterSeconds(response.headers, attempt);
      log(`${BRAND} rate limit reached. Trying again in ${seconds} s (attempt ${attempt + 1} of ${ATTEMPTS}).`);
      await sleep(seconds * 1000);
      continue;
    }
    const payload = parseJson(text);
    if (!response.ok || (isRecord(payload) && payload.error !== undefined && payload.error !== null)) {
      throw apiError(response, payload, text);
    }
    if (!isRecord(payload)) {
      throw new ActionError(`${BRAND} returned a response that is not valid JSON.`);
    }
    return payload;
  }
}

/** The reply text, the finish reason, and the usage object of a chat completion. */
export function readReply(payload) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!isRecord(choice)) {
    throw new ActionError(`${BRAND} returned a response without a reply.`);
  }
  const message = isRecord(choice.message) ? choice.message : {};
  return {
    text: contentText(message.content),
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "",
    usage: isRecord(payload.usage) ? payload.usage : undefined,
  };
}

function contentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function apiError(response, payload, text) {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  let message =
    nonEmpty(error?.message) ??
    (isRecord(payload) ? nonEmpty(payload.error) ?? nonEmpty(payload.detail) ?? nonEmpty(payload.message) : undefined);
  if (!message) {
    const trimmed = text.trim();
    message =
      trimmed && !trimmed.startsWith("<")
        ? trimmed.slice(0, 300)
        : response.statusText || STATUS_CODES[response.status] || "Request failed";
  }
  const code = nonEmpty(error?.code) ?? nonEmpty(error?.type);
  const label = response.ok ? code || "error" : `HTTP ${response.status}${code ? `, ${code}` : ""}`;
  let out = `${BRAND} API error (${label}): ${message}`;
  const hint = HINTS[response.status];
  if (hint && !message.includes("platform.empiriolabs.ai")) {
    out += `${/[.!?]$/.test(out) ? "" : "."} ${hint}`;
  }
  const requestId = nonEmpty(error?.request_id) ?? nonEmpty(response.headers.get("x-request-id"));
  if (requestId) {
    out += `${/[.!?]$/.test(out) ? "" : "."} Request ID: ${requestId}`;
  }
  return new ActionError(out);
}

function retryAfterSeconds(headers, attempt) {
  const header = headers.get("retry-after");
  const value = Number(header);
  if (header !== null && header.trim() !== "" && Number.isFinite(value) && value >= 0) {
    return Math.min(Math.max(Math.ceil(value), 1), 60);
  }
  return Math.min(2 ** attempt, 20);
}

/** Writes a step output in the runner's multiline form. */
export function setOutput(env, name, value) {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  if (value.includes(delimiter)) {
    throw new ActionError(`The ${name} output contains its own delimiter.`);
  }
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`, "utf8");
}

/**
 * Runs the action and returns the exit code. Prompts and replies are never
 * written to the log; the API key is masked, and removed from every message.
 */
export async function main({
  env = process.env,
  fetch = (url, init) => globalThis.fetch(url, init),
  write = (text) => process.stdout.write(text),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  readFile = readFileSync,
} = {}) {
  const secrets = [];
  const log = (line) => write(`${redact(line, secrets)}${EOL}`);
  const command = (name, message) =>
    write(`::${name} title=${BRAND}::${escapeData(redact(message, secrets))}${EOL}`);
  try {
    const apiKey = getInput(env, "api-key");
    if (apiKey) {
      secrets.push(apiKey);
      if (env.GITHUB_ACTIONS === "true") {
        write(`::add-mask::${escapeData(apiKey)}${EOL}`);
      }
    }
    const request = readRequest(env, readFile);
    if (!env.GITHUB_OUTPUT) {
      throw new ActionError("GITHUB_OUTPUT is not set. Run this action as a step of a GitHub Actions workflow.");
    }
    log(`Requesting a reply from ${oneLine(request.model)}.`);
    const payload = await requestReply(request, { fetch, sleep, log });
    const reply = readReply(payload);
    setOutput(env, "text", reply.text);
    setOutput(env, "usage", reply.usage ? JSON.stringify(reply.usage) : "");
    setOutput(env, "finish-reason", reply.finishReason);
    const finish = reply.finishReason ? ` (finish reason: ${oneLine(reply.finishReason)})` : "";
    log(`Received a reply of ${reply.text.length} characters${finish}.`);
    if (reply.usage) {
      const usage = describeUsage(reply.usage);
      if (usage) {
        log(`Usage: ${usage}.`);
      }
    }
    if (reply.finishReason === "length") {
      command("warning", "The reply stopped at the token limit before it was complete. Raise max-tokens for a longer reply.");
    }
    if (!reply.text.trim()) {
      command("warning", "The model returned an empty reply.");
    }
    return 0;
  } catch (error) {
    command("error", error instanceof ActionError ? error.message : `Unexpected error: ${describe(error)}`);
    return 1;
  }
}

function describeUsage(usage) {
  const parts = [];
  for (const [key, label] of [
    ["prompt_tokens", "prompt"],
    ["completion_tokens", "completion"],
    ["total_tokens", "total"],
  ]) {
    if (Number.isFinite(usage[key])) {
      parts.push(`${usage[key]} ${label} tokens`);
    }
  }
  return parts.join(", ");
}

/** Removes the given secrets, and anything shaped like an EmpirioLabs AI key, from text. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join("***");
    }
  }
  return out.replace(KEY_SHAPE, "sk-empiriolabs-***");
}

/** Escapes a workflow command's message the way the runner reads it back. */
export function escapeData(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** A value from the inputs or the API as one log line, so it cannot start a workflow command. */
function oneLine(text) {
  return String(text).replace(/[\r\n\u2028\u2029]+/g, " ");
}

function parseJson(text) {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describe(error) {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && (cause.message || cause.code)) {
      return cause.message || String(cause.code);
    }
    return error.message || error.name;
  }
  return String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
