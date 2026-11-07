# Changelog

## 1.0.0

- First release. Each step sends one chat completion to an EmpirioLabs AI model, from `prompt`, `prompt-file`, or `messages`, with an optional `system` message, `max-tokens`, and `temperature`.
- Outputs: `text` (the reply), `usage` (token usage as JSON), and `finish-reason`.
- Runs on Node.js 24 with no dependencies.
