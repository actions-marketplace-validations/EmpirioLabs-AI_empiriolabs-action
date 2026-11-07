# Security

## Reporting a vulnerability

Report a vulnerability privately through
[GitHub security advisories](https://github.com/EmpirioLabs-AI/empiriolabs-action/security/advisories/new)
or by email to support@empiriolabs.ai. Please do not open a public issue.

## How the action handles your key

- The key is sent only to `https://api.empiriolabs.ai`, over HTTPS, as a bearer token. A request that
  carries it never follows a redirect.
- On a runner, the action masks the key, so the workflow log hides it even when it was not passed from a
  secret. The key is never written to an output or a file, and it is removed from every error message.
- The action does not write prompts or replies to the log. The reply is available only as the `text` output.
- The action has no dependencies. The runner's Node.js runs the code in this repository as it is, with no
  build step and nothing installed.

## Verifying a release

Every release is an immutable GitHub release: its tag cannot be moved to other code, and GitHub records a
release attestation for it. Check a release with the GitHub CLI:

```sh
gh release verify <tag> --repo EmpirioLabs-AI/empiriolabs-action
```

The release workflow also records a build provenance attestation for each file the action runs. From a
checkout of the tag:

```sh
gh attestation verify action.yml --repo EmpirioLabs-AI/empiriolabs-action
gh attestation verify src/index.mjs --repo EmpirioLabs-AI/empiriolabs-action
gh attestation verify src/action.mjs --repo EmpirioLabs-AI/empiriolabs-action
```

To run exactly the code you checked, pin the release's full commit SHA in your workflow.
