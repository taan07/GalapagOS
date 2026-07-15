# Codex provider qualification — isolated-manager gate

**Status: FAIL — do not implement the Codex provider from this spike.**

This additive qualification inspected Codex only. The existing Claude Agent
SDK manager and worker adapters were read, not changed.

## Scope and safety boundary

- Date: 2026-07-15
- Candidate binary: `/Applications/ChatGPT.app/Contents/Resources/codex`
- Observed version: `codex-cli 0.144.2`
- No GalapagOS process, port, SQLite state, runtime checkout, `~/.codex`,
  keychain item, credential file, login, logout, plugin, MCP server, hook,
  skill, marketplace, trust entry, or target-project capability grant was
  changed.
- The npm `codex` launcher on `PATH` was also inspected. Its packaged Darwin
  executable was missing (`ENOENT`), so it was not usable. The desktop-bundled
  binary above was the only usable binary found.

## Reproduction

Run from a disposable or clean worktree. `CODEX_BIN` must name an already
installed binary; the command never downloads, repairs, authenticates, or
copies credentials.

```bash
CODEX_BIN=/absolute/path/to/codex \
  node scripts/probes/codex-provider-qualification.mjs
```

The probe creates a fresh system-temp directory and supplies it as
`CODEX_HOME`. Its only config file is:

```toml
cli_auth_credentials_store = "keyring"
```

The execution cwd is a new empty directory inside that home. Before every
Codex child process, the probe removes `OPENAI_API_KEY` and
`CODEX_ACCESS_TOKEN` from its inherited environment. The home initially holds
only `config.toml` and that empty directory; it therefore has no auth file,
plugins, MCP servers, hooks, skills, marketplaces, trust entries, or
project-scoped configuration. The probe deletes it on exit. It redacts bearer
tokens, token-like strings, and email addresses from its JSON evidence.

For the observed run, the binary printed `codex-cli 0.144.2`, and the isolated
command `codex login status` exited 1 with exactly `Not logged in`.

## App-server protocol facts

The same isolated home successfully generated the version-matched JSON Schema:

```bash
"$CODEX_BIN" app-server generate-json-schema --out "<isolated-CODEX_HOME>/app-server-schema"
```

It produced 267 JSON schema files. The generated v2 schemas include
`ModelListParams`/`ModelListResponse`, `ThreadStartParams`,
`ThreadResumeParams`, `TurnStartParams`, and `TurnInterruptParams`; the request
union explicitly advertises `model/list`, `thread/start`, `thread/resume`,
`turn/start`, and `turn/interrupt`.

`ModelListResponse` defines per-model `model`/`id` and
`supportedReasoningEfforts`. That is sufficient to make a future authenticated
probe test `gpt-5.6-sol` + `high` and `gpt-5.6-terra` + `high`; schema shape is
not proof that either model or effort is entitled for this account.

The same generated protocol exposes read surfaces needed to detect accidental
inheritance: `config/read`, `plugin/list`, `mcpServerStatus/list`, `hooks/list`,
and `skills/list`. They were not invoked because the preceding isolated auth
gate failed, so there are no runtime-reported config/instruction sources or
loaded capabilities to claim. Static home inspection found none.

## Gate results

| Gate | Result | Evidence |
| --- | --- | --- |
| Usable bundled Codex binary/version | PASS | Desktop bundle, `codex-cli 0.144.2` |
| Isolated minimal `CODEX_HOME` | PASS | Fresh temp home, one keyring-only config file |
| Existing ChatGPT auth available under that home | **FAIL** | `login status` → exit 1, `Not logged in` |
| App-server schema generation | PASS | 267 version-matched JSON schemas |
| Stable app-server initialization and `model/list` | NOT RUN | Blocked by failed auth gate; no retry or login |
| `gpt-5.6-sol` / high availability | NOT PROVEN | Requires authenticated `model/list` |
| `gpt-5.6-terra` / high availability | NOT PROVEN | Requires authenticated `model/list` |
| Thread start, turn, interrupt, resume | NOT RUN | Prohibited after failed auth gate |
| Personal/project capability inheritance | NO EVIDENCE OF INHERITANCE | Fresh home/cwd were empty; runtime inspection blocked before initialization |
| Claude behavior | UNCHANGED | No source implementation changed |

## Usage accounting

| Kind | Attempted | Completed |
| --- | ---: | ---: |
| Sol/high manager-shaped no-tool turn | 0 | 0 |
| Terra/high worker-shaped no-write turn | 0 | 0 |
| **Total live model turns** | **0** | **0** |

No reviewers, critics, retries, or model calls ran.

## Blocker and next decision

The keyring-only isolated home did not see existing ChatGPT authentication.
This disproves the minimum manager-provider gate **for this isolation design on
this machine**. It does not establish whether a deliberately authenticated,
GalapagOS-owned Codex home could be acceptable; testing that would require an
explicit product and credential-ownership decision.

Do not add a provider adapter or weaken lane enforcement. The next spike should
first obtain that explicit decision, then on a user-authorized, disposable
Codex home: authenticate without copying any credential, call `initialize`,
`config/read`, `plugin/list`, `mcpServerStatus/list`, `hooks/list`,
`skills/list`, and `model/list`; fail on any unexpected source/capability; and
only then use at most the two specified tiny read-only turns to verify
Sol/high and Terra/high plus start/interrupt/resume behavior.
