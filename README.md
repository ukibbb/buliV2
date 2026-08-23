# Buli

Small Bun project for the Buli terminal app.

## Requirements

- Bun 1.3.12 or newer
- [ripgrep](https://github.com/BurntSushi/ripgrep) available as `rg`

## Terminal app development

Run the app in restart-on-save mode from the project root:

```bash
bun run dev
```

That runs `cli/main.ts` with Bun watch and opens the OpenTUI console overlay so `console.log`, `console.debug`, `console.warn`, and `console.error` are visible while the TUI owns the terminal screen.

Inside the TUI:

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

If you want watch mode with the console hidden at startup:

```bash
bun run dev:quiet
```

Useful feedback commands:

```bash
bun run typecheck
bun test
```

OpenTUI rendering conventions are documented in
[`docs/opentui-rendering.md`](docs/opentui-rendering.md).

## Architecture

Source code is grouped by feature and dependency direction rather than by
technical layer:

- `agent` owns messages, model and tool ports, run state, and approval contracts
- `sessions` owns persistence, recovery, snapshots, and context compaction
- `tools` contains the built-in workspace tool implementations and their approval UI
- `authentication` contains provider-neutral authentication core and UI
- `providers/openai` adapts OpenAI to the agent and authentication contracts
- `app` composes features and owns connected application screens and navigation
- `terminal` provides low-level OpenTUI rendering, clipboard, input, viewport, and theme primitives
- `common` contains dependency-free primitives shared by multiple features

Core dependencies point toward contracts: sessions, tools, and providers may
depend on `agent`, while `app` composes every feature. Feature-owned UI may use
terminal primitives, but feature core does not depend on OpenTUI. Cross-feature
imports use each feature's public `index.ts` surface.

## Workspace changes

`apply_patch` prepares one proposal in memory and shows its exact diff before
changing the workspace. Rejecting or cancelling before approval discards that
proposal; the separate `Apply` action consumes it once after checking that the
source files still match the preview. Once application starts, Buli finishes
the patch and reports if cancellation raced with a committed change.

Buli writes approved changes directly to their final paths and does not create
temporary source-file copies. A forced process exit during that write can leave
a missing, partial, or partially applied file, so inspect the workspace before
retrying after a crash.

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

On restart, saved sessions are available through `/sessions`. Opening one restores its completed turns for the next model request. `/clear` removes the conversation history but keeps the session entry. In-progress assistant snapshots are kept only in memory, so a process crash can lose the unfinished response without growing the JSONL file once per streamed token.

Pending steering and follow-up messages are also kept only in memory. `Escape` restores them to the editor before aborting, but exiting or crashing the process can discard them.

Concurrent writers are not coordinated for the shared workspace session log. Running multiple Buli processes in one workspace may lose session updates.

If a crash or watch restart leaves the terminal in a strange state, run:

```bash
reset
```
