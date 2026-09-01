# Buli

Small Bun project for the Buli terminal app.

## Installation

Buli supports macOS and Linux on ARM64 and x64. Choose one installation method;
using both npm and the standalone installer can leave multiple `buli` commands
in `PATH`.

### npm

Install the latest stable release globally. The package downloads the matching
native executable, so Bun is not required:

```bash
npm install --global @ukibbb/buli
```

Verify the installation:

```bash
buli --version
buli --help
```

Install the latest release candidate instead:

```bash
npm install --global @ukibbb/buli@next
```

Update an npm-managed installation with npm:

```bash
npm install --global @ukibbb/buli@latest
```

### Standalone installer

Install the latest stable release on macOS or Linux without Bun, npm, ripgrep,
or fd installed system-wide:

```bash
curl -fsSL https://raw.githubusercontent.com/ukibbb/buliV2/main/install.sh | sh
```

The installer verifies the release checksum and installs Buli with private
ripgrep and fd sidecars under `~/.local`. If necessary, it adds `~/.local/bin` to the
configuration file for zsh, bash, sh, or fish. Open a new terminal afterward.

Verify the installation after opening a new terminal:

```bash
buli --version
buli --help
```

Install a specific version, including a release candidate, by passing its Git
tag to the downloaded script:

```bash
curl -fsSL https://raw.githubusercontent.com/ukibbb/buliV2/main/install.sh \
  | sh -s -- v0.1.0-rc.10
```

Set `BULI_INSTALL_PREFIX` to use a different prefix or
`BULI_NO_MODIFY_PATH=1` to prevent shell configuration changes.

Check for a newer stable release or update a standalone installation:

```bash
buli update --check
buli update
```

The updater downloads the release for the current platform, verifies its
SHA-256 checksum, validates the new executables, and replaces the installation
only after those checks pass. Package-manager installations are not modified.

## Workspace instructions

Buli creates a `.buli` directory in the workspace root when it starts. To add
project-specific instructions, create one of these files inside it:

1. `.buli/BULI.md`
2. `.buli/AGENTS.md`
3. `.buli/CLAUDE.md`

If several files exist, Buli loads only the first one in that order. Filenames
are case-sensitive, and each file must be a regular, valid UTF-8 file no larger
than 64 KiB. An empty higher-priority file still prevents lower-priority files
from loading.

Instructions are read once at startup, so restart Buli after editing them. Their
contents are sent to the selected model as lower-priority project conventions;
they cannot add tools or replace Buli's edit and command approval rules. A
project may commit its `.buli` directory when the team wants to share the same
instructions.

## Development requirements

- Bun 1.3.12 or newer
- [ripgrep](https://github.com/BurntSushi/ripgrep) available as `rg`
- [fd](https://github.com/sharkdp/fd) available as `fd`

## Terminal app development

Run the app in development mode from the project root:

```bash
bun run dev
```

That runs `cli/main.ts` with Bun watch and opens the OpenTUI console overlay so `console.log`, `console.debug`, `console.warn`, and `console.error` are visible while the TUI owns the terminal screen.

Inside the TUI:

- type `@` to complete files and directories with fd; selected paths are read lazily and may point outside the workspace
- press `Ctrl+V` to attach a clipboard screenshot directly to the next model request
- drag over terminal text to copy the selection to the clipboard
- press `Enter` during an active response to queue steering for the next model request
- press `Alt+Enter` to queue follow-up work after tools and steering finish
- press `Escape` to restore undelivered queued input and stop the active response
- use `/new` to return to a fresh Home screen
- use `/sessions` to reopen a saved conversation
- use `/model` and `/reasoning` to change the next run configuration
- use `/login` and `/logout` to manage provider authentication
- press `Ctrl+D` to toggle the console
- use `Up`/`Down` to scroll while the console is focused
- use `+`/`-` to resize the console
- press `Ctrl+S` to save the console logs
- press `Ctrl+C` to exit

Path references selected through `@` are stored with the prompt so the model can
inspect them lazily. Pi-style file tools accept relative and absolute paths;
they are not restricted to the workspace. Screenshot bytes are stored as base64
in the local, unencrypted JSONL session and sent to the selected model.

If you want watch mode with the console hidden at startup:

```bash
bun run dev:quiet
```

Useful feedback commands:

```bash
bun run typecheck
bun run test
```

Maintainers should follow [`docs/releasing.md`](docs/releasing.md) when creating
GitHub and npm releases.

OpenTUI rendering conventions are documented in
[`docs/opentui-rendering.md`](docs/opentui-rendering.md).

## Architecture

Source code is grouped by feature and dependency direction rather than by
technical layer:

- `agent` owns messages, model and tool ports, run state, and approval contracts
- `sessions` owns persistence, recovery, snapshots, and context compaction
- `tools` contains the built-in workspace tools and generic tool approval UI
- `authentication` contains provider-neutral authentication core and UI
- `providers/openai` adapts OpenAI to the agent and authentication contracts
- `app` composes features and owns connected application screens and navigation
- `terminal` provides low-level OpenTUI rendering, clipboard, input, viewport, and theme primitives
- `common` contains dependency-free primitives shared by multiple features

Core dependencies point toward contracts: sessions, tools, and providers may
depend on `agent`, while `app` composes every feature. Feature-owned UI may use
terminal primitives, but feature core does not depend on OpenTUI. Cross-feature
imports use each feature's public `index.ts` surface.

## Pi agent contract alignment

Buli's agent core follows Pi's lifecycle vocabulary and loop structure, but it
is intentionally a semantic superset rather than an API-compatible copy. Buli
keeps run IDs, separate prompt acceptance and run settlement, a critical
persistence sink, closed durable message types, interactive tool approvals, and
sequential local tool execution. Agent interfaces use the `I...` prefix and
type aliases use `T...`; runtime classes, functions, event discriminants, and
persisted fields remain unprefixed.

The references below are pinned to Pi commit
[`936aff0`](https://github.com/earendil-works/pi/tree/936aff00918de1187f085f123c2812d8f2d67745/packages/agent)
so future Pi changes do not silently change the examples.

| Candidate improvement | Pi reference | Why it could help Buli | Why it is not adopted yet |
| --- | --- | --- | --- |
| Graceful `shouldStopAfterTurn` hook | [loop implementation](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/packages/agent/src/agent-loop.ts#L224-L259) | Can stop at a turn boundary for an iteration budget or before compaction, after the current response and tools finish normally. | Buli must first define whether queued steering and follow-up messages stay pending, return to the editor, or are persisted when the hook stops a run. |
| Parallel tool execution | [sequential and parallel paths](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/packages/agent/src/agent-loop.ts#L411-L554) | Independent reads could finish faster while tool-result messages still follow model source order. | Concurrent progress, cancellation, critical persistence, and approval ordering need an explicit policy. Mutating or approval-based Buli tools must remain sequential. |
| Generic before/after hooks | [tool lifecycle](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/packages/agent/src/agent-loop.ts#L586-L758) | Provides one place for policy checks, auditing, and result post-processing. | Buli adopted only the small `prepareArguments` input-compatibility hook. Generic result hooks could still rewrite a durable outcome after a tool has reported side effects. |
| Public `continue()` | [Agent implementation](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/packages/agent/src/agent.ts#L360-L388) | Allows retrying from an existing user or tool-result tail without creating another user message. | Buli's `accepted` promise currently means that a new prompt is durable. A continuation has no new prompt, so acceptance, run IDs, recovery, and UI state need a separate contract. |
| Queue modes such as `all` | [pending-message queue](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/packages/agent/src/agent.ts#L125-L159) | Can inject several queued messages into one provider request instead of one message per response. | Buli currently restores one dequeued message after a persistence failure. Batch draining would require atomic persistence and restoration of the entire batch. |
| Durable tree harness | [current harness surface](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/packages/agent/src/harness/agent-harness.ts#L347-L507) | The proposed lanes, branching, and durable operations may be useful if Buli later needs conversation trees or resumable effects. | Pi's current harness is a scaffold whose main run operations throw `HarnessNotImplemented`. Buli's linear `AgentSession` is complete and should not be replaced by unfinished reference code. |

When adopting one of these features, port its observable behavior and focused
tests into Buli's existing boundaries. Do not import implementation code from
the `_temp/pi` reference checkout or migrate the session format only for naming
parity.

## Workspace changes

The default workspace registry exposes `read`, `find`, `grep`, `edit`, `write`,
`bash`, `apply_file_changes`, and `reject_file_changes`; the application also
adds `tool_output`. The file tools and Bash's public `command`/`timeout` schema
port the behavior of Pi commit
[`6c87d9a`](https://github.com/badlogic/pi-mono/tree/6c87d9a026677b601e8278030dcf1ad97fe0bd86/packages/coding-agent/src/core/tools).

`edit` applies one or more non-overlapping `oldText`/`newText` replacements to a
single original file state. It preserves a UTF-8 BOM and the detected LF or
CRLF style and uses Pi's Unicode and trailing-whitespace fallback when an exact
match is unavailable. `write` creates missing parent directories and creates or
fully overwrites one file.

In the default application, `edit` and `write` create one immutable proposal per
session instead of modifying the workspace. The transcript renders its exact
diff, and the model must wait for acceptance in a later user message before
calling `apply_file_changes`. A refusal resolves it through
`reject_file_changes`; a replacement first expires the previous proposal.

Applying verifies that the file still matches the proposal's base content and
serializes mutations for the same path. If persisting the `applied` status
fails, Buli restores the base content and leaves the proposal pending for a
retry. A retry can also finish the durable transition when the exact target is
already present. The workspace write and session JSONL cannot form one atomic
filesystem transaction, so a process termination in the narrow interval
between them can still leave the target on disk without an `applied` record.

Library callers that construct `edit` or `write` without a proposal store keep
the direct-write behavior. In that mode the generated system prompt requires an
exact diff and explicit acceptance before the mutating tool call. This remains
a conversational policy rather than a runtime security boundary.

`bash` uses the same conversational boundary for commands. Before calling the
tool, the model must show the exact command and optional timeout, explain its
program, subcommands, flags, arguments, operators, working directory, expected
result, and side effects, then wait for explicit acceptance in a later user
message. Acceptance applies only to that command and timeout; changing either
requires a new explanation and acceptance. The tool executes directly without
an approval modal.

Commands always start in the workspace root through
`/bin/bash --noprofile --norc -c`. The timeout is optional and has no default.
This process is not sandboxed, and deliberately detached descendants may
outlive the command.

## Paginated tool output

`read` is text-only and returns at most 2,000 complete lines or 50 KiB. File
pages continue through the 1-based `offset` and optional line `limit`; a first
line larger than 50 KiB produces a Bash fallback instead of a partial line.
`find` stops at 1,000 results by default. `grep` stops at 100 matches by default
and shortens individual result lines to 500 characters. Both search tools also
cap their formatted output at 50 KiB, return a concise result-count summary,
and tell the model to increase `limit` or narrow the query.

The self-limiting `read`, `find`, and `grep` results remain inline. Before a
larger result from another tool is shortened to a preview, Buli writes its
complete content to a private temporary store and returns an `outputId`;
`tool_output` reads that content in bounded exact pages. Bash streams complete
stdout and stderr into separate parts
from the first byte while retaining small previews in the original result. Text
pages preserve UTF-8 boundaries and BOM characters; arbitrary non-UTF-8 command
bytes, including output smaller than the inline limit, receive an `outputId` and
are available as exact base64 pages.

This store is intentionally ephemeral and session-bound. Its files use private
permissions and are removed when Buli shuts down. An `outputId` may remain in a
saved conversation, but after restart it expires explicitly and the source tool
must be run again. Storage or quota failures mark the tool result as failed
instead of presenting an incomplete prefix as complete. Pages explicitly read
by the model become ordinary tool-result messages and can therefore appear in
the saved JSONL conversation even though the complete backing artifact does not.

## Authentication

Buli uses ChatGPT/Codex OAuth for OpenAI models. This is separate from the
OpenAI Platform API and does not use `OPENAI_API_KEY`.

Start the interactive provider and login-method picker with:

```bash
buli login
```

The browser method opens an OpenAI authorization page and listens on
`http://localhost:1455/auth/callback`. If the callback cannot reach Buli, paste
the complete callback URL into the terminal. Device login displays a URL and a
one-time code instead.

Disconnect locally with:

```bash
buli logout
```

Logout removes Buli's local token but does not sign the browser out of ChatGPT
or revoke copies of the token stored elsewhere.

Credentials are stored as plaintext JSON in `~/.buli/auth.json`. Buli protects
the directory and file with `0700` and `0600` permissions on POSIX systems,
and uses atomic writes. Concurrent credential updates are not coordinated and
may overwrite each other.
The file is keyed by provider and supports OAuth and API-key credentials;
the current OpenAI/ChatGPT integration accepts OAuth only.

## Session persistence

Buli stores multiple conversations per workspace. The app starts on Home without creating a session; the first non-empty prompt creates one, using that prompt as its title. Completed messages and session metadata are appended to a JSONL file under `~/.buli/sessions/`; the filename is the SHA-256 hash of the canonical workspace path.

On restart, saved sessions are available through `/sessions`. Opening one restores its completed turns for the next model request. `/new` returns Home without changing the saved conversation, and the next prompt starts a separate session. In-progress assistant snapshots are kept only in memory, so a process crash can lose the unfinished response without growing the JSONL file once per streamed token.

Pending steering and follow-up messages are also kept only in memory. `Escape` restores them to the editor before aborting, but exiting or crashing the process can discard them.

Public file-change proposal records and cumulative compaction checkpoints are
stored in the same JSONL history. Complete proposal base and target contents
remain private and in memory, so a pending proposal is marked `expired` after a
restart and must be generated again. A saved compaction checkpoint remains
visible at its transcript anchor and supplies the context summary for later
model requests.

Concurrent writers are not coordinated for the shared workspace session log. Running multiple Buli processes in one workspace may lose session updates.

If a crash or watch restart leaves the terminal in a strange state, run:

```bash
reset
```
