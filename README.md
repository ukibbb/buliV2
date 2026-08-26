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
they cannot add tools, change workspace boundaries, or replace required command
and patch approvals. A project may commit its `.buli` directory when the team
wants to share the same instructions.

## Development requirements

- Bun 1.3.12 or newer
- [ripgrep](https://github.com/BurntSushi/ripgrep) available as `rg`
- [fd](https://github.com/sharkdp/fd) available as `fd` or `fdfind`

## Terminal app development

Run the app in restart-on-save mode from the project root:

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

Selected external paths authorize only `read` and `glob`; other workspace tools
keep their existing boundaries. Screenshot bytes are stored as base64 in the
local, unencrypted JSONL session and sent to the selected model.

If you want watch mode with the console hidden at startup:

```bash
bun run dev:quiet
```

Useful feedback commands:

```bash
bun run typecheck
bun test
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

On restart, saved sessions are available through `/sessions`. Opening one restores its completed turns for the next model request. `/new` returns Home without changing the saved conversation, and the next prompt starts a separate session. In-progress assistant snapshots are kept only in memory, so a process crash can lose the unfinished response without growing the JSONL file once per streamed token.

Pending steering and follow-up messages are also kept only in memory. `Escape` restores them to the editor before aborting, but exiting or crashing the process can discard them.

Concurrent writers are not coordinated for the shared workspace session log. Running multiple Buli processes in one workspace may lose session updates.

If a crash or watch restart leaves the terminal in a strange state, run:

```bash
reset
```
