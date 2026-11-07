// Checks action.yml, the README, and the changelog against the code, and the
// GitHub Marketplace rules a listing has to meet.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { VERSION } from "../src/action.mjs";

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path) => readFileSync(root(path), "utf8");

const COLORS = ["white", "black", "yellow", "blue", "green", "orange", "red", "purple", "gray-dark"];
const ICONS = read("test/fixtures/branding-icons.txt")
  .split("\n")
  .filter((line) => line && !line.startsWith("#"));

/** Reads the subset of YAML that action.yml uses: scalars, and inputs and outputs two levels deep. */
function parseActionYml(text) {
  const doc = { inputs: {}, outputs: {}, branding: {}, runs: {} };
  let section;
  let item;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    let m;
    if ((m = /^([a-z-]+):\s*(.*)$/.exec(line))) {
      [section, item] = [m[1], undefined];
      if (m[2]) {
        doc[section] = m[2];
      }
    } else if ((m = /^ {2}([a-z0-9-]+):\s*(.*)$/.exec(line)) && section) {
      if (section === "inputs" || section === "outputs") {
        item = m[1];
        doc[section][item] = {};
      } else {
        doc[section][m[1]] = m[2];
      }
    } else if ((m = /^ {4}([a-z-]+):\s*(.*)$/.exec(line)) && item) {
      doc[section][item][m[1]] = m[2];
    } else {
      throw new Error(`action.yml line not understood: ${line}`);
    }
  }
  return doc;
}

const action = parseActionYml(read("action.yml"));
const source = read("src/action.mjs");
const readme = read("README.md");

test("action.yml meets the GitHub Marketplace rules", () => {
  assert.equal(action.name, "EmpirioLabs AI");
  assert.equal(action.author, "EmpirioLabs AI");
  assert.ok(action.description.length > 0 && action.description.length < 125, `${action.description.length} characters`);
  assert.ok(COLORS.includes(action.branding.color), action.branding.color);
  assert.ok(ICONS.includes(action.branding.icon), action.branding.icon);
});

test("action.yml runs src/index.mjs on Node.js 24", () => {
  assert.equal(action.runs.using, "node24");
  assert.equal(action.runs.main, "src/index.mjs");
  assert.ok(existsSync(root(action.runs.main)));
});

test("action.yml declares exactly the inputs the code reads", () => {
  const used = new Set([...source.matchAll(/getInput\(env, "([a-z-]+)"\)/g)].map((m) => m[1]));
  assert.deepEqual(Object.keys(action.inputs).sort(), [...used].sort());
  for (const [name, input] of Object.entries(action.inputs)) {
    assert.ok(input.description, `${name} has no description`);
    assert.equal(input.required, name === "api-key" || name === "model" ? "true" : "false", name);
    assert.equal(input.default, undefined, `${name} has a default`);
  }
});

test("action.yml declares exactly the outputs the code writes", () => {
  const written = new Set([...source.matchAll(/setOutput\(env, "([a-z-]+)"/g)].map((m) => m[1]));
  assert.deepEqual(Object.keys(action.outputs).sort(), [...written].sort());
  for (const [name, output] of Object.entries(action.outputs)) {
    assert.ok(output.description, `${name} has no description`);
  }
});

test("the README documents every input and output", () => {
  for (const name of [...Object.keys(action.inputs), ...Object.keys(action.outputs)]) {
    assert.ok(readme.includes(`| \`${name}\` |`), `${name} is missing from the README tables`);
  }
});

test("the README and the changelog are at the current version", () => {
  const uses = [
    ...readme.matchAll(/EmpirioLabs-AI\/empiriolabs-action@(v[0-9][^\s`]*)/g),
    ...readme.matchAll(/EmpirioLabs-AI\/empiriolabs-action@\S+ # (v[0-9][^\s`]*)/g),
  ].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const ref of uses) {
    assert.equal(ref, `v${VERSION}`);
  }
  assert.equal(/^## (\S+)$/m.exec(read("CHANGELOG.md"))?.[1], VERSION);
});

test("the README never puts an expression inside a run script", () => {
  // A reply is untrusted text: examples pass it to a script through env.
  let block;
  readme.split(/\r?\n/).forEach((line, index) => {
    const indent = line.length - line.trimStart().length;
    if (block !== undefined && line.trim() && indent <= block) {
      block = undefined;
    }
    const run = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (run) {
      if (run[2] === "|" || run[2] === ">") {
        block = run[1].length;
      } else {
        assert.ok(!run[2].includes("${{"), `README line ${index + 1}: ${line}`);
      }
    } else if (block !== undefined) {
      assert.ok(!line.includes("${{"), `README line ${index + 1}: ${line}`);
    }
  });
});

test("no published file contains an em dash", () => {
  const files = [
    "action.yml",
    "README.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "LICENSE",
    ...readdirSync(root("src")).map((name) => `src/${name}`),
    ...readdirSync(root(".github/workflows")).map((name) => `.github/workflows/${name}`),
  ];
  for (const file of files) {
    assert.ok(!read(file).includes("\u2014"), file);
  }
});
