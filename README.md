# EmpirioLabs AI

Send a prompt to an [EmpirioLabs AI](https://empiriolabs.ai) model from a GitHub Actions workflow and use the reply in later steps: summarize a pull request, draft release notes, or review a file. Each step runs one chat completion with a chat model from the [EmpirioLabs AI catalog](https://docs.empiriolabs.ai/models-pricing).

## Setup

1. Create an API key at [platform.empiriolabs.ai](https://platform.empiriolabs.ai/dashboard/api-keys).
2. In your repository, open **Settings > Secrets and variables > Actions** and add:
   - a secret named `EMPIRIOLABS_API_KEY` that holds the key;
   - a variable named `EMPIRIOLABS_MODEL` that holds a model ID from [Models & Pricing](https://docs.empiriolabs.ai/models-pricing).

With the model ID in a variable, you change models without editing the workflow.

## Usage

```yaml
steps:
  - uses: EmpirioLabs-AI/empiriolabs-action@v1.0.0
    id: ai
    with:
      api-key: ${{ secrets.EMPIRIOLABS_API_KEY }}
      model: ${{ vars.EMPIRIOLABS_MODEL }}
      prompt: Explain what a semantic version number is, in two sentences.

  - name: Print the reply
    env:
      REPLY: ${{ steps.ai.outputs.text }}
    run: printf '%s\n' "$REPLY"
```

### Summarize a pull request

`prompt-file` sends the text of a file after `prompt`. Use it for long input such as a diff or a log.

```yaml
name: Pull request summary

on: pull_request

permissions:
  contents: read

jobs:
  summary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Save the diff
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
        run: git diff "$BASE...HEAD" > "$RUNNER_TEMP/changes.diff"

      - uses: EmpirioLabs-AI/empiriolabs-action@v1.0.0
        id: ai
        with:
          api-key: ${{ secrets.EMPIRIOLABS_API_KEY }}
          model: ${{ vars.EMPIRIOLABS_MODEL }}
          system: You review code changes. Answer in Markdown.
          prompt: Summarize this diff in at most five bullet points.
          prompt-file: ${{ runner.temp }}/changes.diff
          max-tokens: 1000

      - name: Add the summary to the run
        env:
          SUMMARY: ${{ steps.ai.outputs.text }}
        run: printf '%s\n' "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"
```

GitHub does not pass secrets to workflows that run for pull requests from forks, so there the step fails with `api-key is required`.

### Send a conversation

```yaml
- uses: EmpirioLabs-AI/empiriolabs-action@v1.0.0
  id: ai
  with:
    api-key: ${{ secrets.EMPIRIOLABS_API_KEY }}
    model: ${{ vars.EMPIRIOLABS_MODEL }}
    system: You write short release notes.
    messages: |
      [
        {"role": "user", "content": "Changes: faster uploads; file names with spaces no longer fail."},
        {"role": "assistant", "content": "Uploads are faster, and file names with spaces now work."},
        {"role": "user", "content": "Write that as two bullet points."}
      ]
```

### Use the token usage and the finish reason

```yaml
- name: Report token usage
  env:
    TOTAL_TOKENS: ${{ fromJSON(steps.ai.outputs.usage).total_tokens }}
  run: echo "Tokens used: $TOTAL_TOKENS"

- name: Stop when the reply was cut off
  if: steps.ai.outputs.finish-reason == 'length'
  run: |
    echo "::error::The reply reached the token limit. Raise max-tokens."
    exit 1
```

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `api-key` | yes | Your EmpirioLabs AI API key. Pass it from a secret. |
| `model` | yes | A model ID from [Models & Pricing](https://docs.empiriolabs.ai/models-pricing). |
| `prompt` | | The message to send. |
| `prompt-file` | | A file whose text is sent as the message, after `prompt` when both are set. A relative path is read from the workspace. |
| `messages` | | The whole conversation as a JSON array of messages, each with a `role` and `content`, instead of `prompt` and `prompt-file`. |
| `system` | | A system message, sent first. |
| `max-tokens` | | The most tokens the reply may contain. |
| `temperature` | | Sampling temperature, such as `0.2`. |

Set one of `prompt`, `prompt-file`, and `messages`. The model's defaults apply when `max-tokens` and `temperature` are not set.

## Outputs

| Output | Description |
| --- | --- |
| `text` | The model's reply. |
| `usage` | Token usage as JSON, with `prompt_tokens`, `completion_tokens`, and `total_tokens`. |
| `finish-reason` | Why the model stopped, such as `stop` for a complete reply or `length` when the reply reached the token limit. |

## Notes

- **Untrusted text.** A reply can contain any text, including text that looks like a command. Pass outputs to a script through `env`, as the examples do, never as an expression inside `run`.
- **Logs.** The action does not write prompts or replies to the workflow log, and it masks the API key.
- **Billing.** Each run is one request, billed to the account that owns the API key at the model's price on [Models & Pricing](https://docs.empiriolabs.ai/models-pricing).
- **Rate limits.** A request refused because a rate limit was reached is sent again after a short wait, up to three attempts in all. Other failures are not sent again.
- **Pinning.** Release tags never move. To pin the exact code, use the release's full commit SHA, as in `uses: EmpirioLabs-AI/empiriolabs-action@<commit SHA> # v1.0.0`. Dependabot keeps either form up to date.
- **Runners.** The action runs on Linux, Windows, and macOS runners and needs outbound HTTPS access to `api.empiriolabs.ai`.

## Development

The action uses only Node.js 24 and its standard library. Run the tests with:

```sh
node --test "test/*.test.mjs"
```

## Links

- [EmpirioLabs AI documentation](https://docs.empiriolabs.ai)
- [Models & Pricing](https://docs.empiriolabs.ai/models-pricing)
- [API keys](https://platform.empiriolabs.ai/dashboard/api-keys)
- [Security policy](SECURITY.md)
- Support: support@empiriolabs.ai

## License

MIT
