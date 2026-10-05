# Buli

An AI coding assistant for your terminal.

Explore a codebase, work on files, and run commands through a conversational
terminal interface. Connect OpenAI, Kimi Code, or DeepSeek, resume conversations
by project, and explore side questions in read-only branches.

[Installation](#installation) · [Quick start](#quick-start) ·
[Usage](#usage) · [Releases](https://github.com/ukibbb/buliV2/releases) ·
[Report an issue](https://github.com/ukibbb/buliV2/issues)

## Features

- **Work directly with your code** — find, read, search, and edit files, and run
  shell commands from the conversation.
- **Choose your provider** — connect OpenAI through ChatGPT/Codex, Kimi Code,
  or DeepSeek, and select models from the terminal.
- **Keep conversations by project** — reopen saved sessions without starting over.
- **Explore side questions** — use read-only branches without adding their
  messages to the parent conversation.
- **Manage long conversations** — summarize older context while preserving saved
  history, or queue instructions while Buli is working.
- **Provide project conventions** — load workspace-specific instructions from
  `.buli/BULI.md`, `.buli/AGENTS.md`, or `.buli/CLAUDE.md`.

## Installation

Native releases support **macOS and Linux on ARM64 and x64**. Bun is not required
for an installed release. Choose one installation method to avoid multiple
`buli` commands in your `PATH`.

### npm

Requires Node.js 18 or newer and npm.

```bash
npm install --global @ukibbb/buli
```

The package downloads the matching native executable and its private ripgrep
and fd binaries, and verifies the published SHA-256 checksum.

### Standalone installer

```bash
curl -fsSL https://raw.githubusercontent.com/ukibbb/buliV2/main/install.sh | sh
```

The installer downloads and verifies the release, then installs Buli and its
private ripgrep and fd binaries under `~/.local`. Bun and Node.js are not
required. The script requires `curl`, standard Unix utilities, and either
`sha256sum` or `shasum`.

If needed, it updates your shell configuration to include `~/.local/bin` in
`PATH`. Open a new terminal afterward. Set `BULI_INSTALL_PREFIX` to customize
the installation prefix, or `BULI_NO_MODIFY_PATH=1` to prevent shell configuration
changes. These variables must be set for the `sh` process running the installer.

### Verify the installation

```bash
buli --version
buli --help
```

Release archives are also available on the
[releases page](https://github.com/ukibbb/buliV2/releases).

## Quick start

Connect a provider using the interactive login picker:

```bash
buli login
```

Then launch Buli from your project directory:

```bash
cd your-project
buli
```

Use `/model` to select an available model, then describe what you want to do:

> Explain how authentication works in this project and identify the tests that cover it.

Buli uses the directory you launch it from as the workspace root. Your first
non-empty prompt creates a session. Use `/sessions` to reopen a saved conversation
or `/new` to start fresh.

## Providers

| Provider | Authentication |
| --- | --- |
| OpenAI / ChatGPT / Codex | ChatGPT/Codex OAuth through browser or device login |
| Kimi Code (.com) | Kimi Code .com API key |
| DeepSeek | DeepSeek API key |

Connect or disconnect providers with `buli login` and `buli logout`, or use
`/login` and `/logout` inside the app. Kimi Code and DeepSeek keys are stored
at login but are not verified online by the login flow.

The OpenAI integration uses ChatGPT/Codex authentication, not the OpenAI Platform
API or `OPENAI_API_KEY`. Model availability depends on the connected account.
Use `/reasoning` to choose from the selected model's supported reasoning levels.

Web search uses a separate OpenAI-backed connection. It requires connected
OpenAI credentials even when the conversation uses Kimi Code or DeepSeek.

Provider access, usage limits, and charges are governed by your provider account.
Buli does not include model access. See [OpenAI model details](docs/openai-models.md)
for account discovery and request settings.

## Usage

### Commands

| Command | Action |
| --- | --- |
| `/new` | Return to Home; the next prompt starts a new session. |
| `/sessions` | Open a saved conversation for the current workspace. |
| `/model` | Select the model for new prompts. |
| `/reasoning` | Select the reasoning effort for new prompts. |
| `/login` | Connect a provider. |
| `/logout` | Disconnect a provider locally. |
| `/branch` | Start a read-only side conversation in the active session. |
| `/return` | Return to the parent branch without transferring side messages. |
| `/compact` | Summarize older context without deleting saved history. |
| `/novibe` | Connect the active session to the local NoVibe MCP server. |
| `/novibe off` | Disconnect NoVibe from the active session without logging out. |
| `/novibe login` | Authorize Buli through the NoVibe browser consent screen. |
| `/novibe status` | Show account access and current conversation tool status. |
| `/novibe logout` | Revoke Buli access and disconnect its NoVibe sessions. |

Branches restrict tools to those classified as read-only; they are conversation
branches, not Git branches or filesystem snapshots. Returning to the parent does
not merge the side conversation into its context.

Long conversations can be compacted automatically. Compaction uses the active
run's model and reasoning settings; manual compaction uses the current selection.
It does not automatically switch to a cheaper model.

### Input and shortcuts

| Input | Action |
| --- | --- |
| `@` | Complete a file or directory path for the model to inspect when needed. |
| `Enter` | Send a prompt; during a response, queue steering for the next model request. |
| `Alt+Enter` | Queue follow-up work after tools and steering finish. |
| `Escape` | Stop the active response and restore undelivered queued input to the editor. |
| `Ctrl+V` | Paste clipboard content, including image attachments where supported. |
| Mouse selection | Copy selected terminal text to the clipboard. |
| `Ctrl+C` | Exit Buli. |

Image support depends on the selected provider and model. Pending steering and
follow-up messages are held in memory: exiting or crashing can discard them.

### NoVibe integration

`/novibe` connects to a separately running MCP (Model Context Protocol) server at
`http://127.0.0.1:8000/mcp/`. Buli does not start or install that server. This is a
specific NoVibe integration, not a general-purpose server configuration interface.
Only connect a server you trust: its tools and instructions become available to
the session.

Run `/novibe login` before activating tools. The authorization server is pinned
to `http://localhost:8000`; the browser UI normally runs at `http://localhost:3000`.
The NoVibe backend requires migration `0009_mcp_oauth`. Login uses PKCE and a
random ephemeral IPv4 loopback callback, with GitHub sign-in if needed. Approval
allows reading, creating, changing and deleting your NoVibe resources.

Login does not create a conversation or enable tools. Use `/novibe` separately.
NoVibe credentials are stored in Buli's local auth store, not conversation history.
They are separate from model-provider credentials and browser sessions. Refresh
is serialized through the auth-store file lock. `/novibe logout` does not log out
the browser; if server revocation cannot be confirmed, local credentials are still
removed and Buli reports that limitation. Completed writes are not undone.

## Project instructions

Buli creates a `.buli` directory in the workspace at startup. Add project
conventions using one of these files, in priority order:

1. `.buli/BULI.md`
2. `.buli/AGENTS.md`
3. `.buli/CLAUDE.md`

For example, `.buli/BULI.md` might contain:

```markdown
# Project conventions

- Use the existing package manager and lockfile.
- Add regression tests for bug fixes.
- Run the relevant checks before reporting a change as complete.
```

Buli loads only the first existing file in that order. An empty higher-priority
file still prevents lower-priority files from loading. Filenames are
case-sensitive; the selected file must be a regular, valid UTF-8 file no larger
than 64 KiB. Symbolic links must resolve within the workspace.

Instructions are read once at startup and included in model requests as project
conventions. **Restart Buli after editing them.** They do not grant new tools or
change runtime tool-access policies. Only use instruction files you trust;
prompt instructions are not a security boundary.

## Data and safety

**Buli runs local tools with your user account's permissions. It is not a sandbox.**

- File tools accept relative and absolute paths, including paths outside the
  workspace. `edit` and `write` modify files directly when invoked.
- Shell commands start in the workspace root through
  `/bin/bash --noprofile --norc -c`. There is no default timeout, and deliberately
  detached child processes may outlive a command.
- Buli's instructions require agreement before changes. This is a conversational
  rule, not an enforced approval dialog or filesystem security boundary. Review
  changes and use version control or backups.
- Prompts, project instructions, relevant file content, tool results, and attached
  images may be sent to model providers. Read-only operation does not mean offline
  or private operation.

### Local storage

| Data | Location |
| --- | --- |
| Provider credentials | `~/.buli/auth.json` |
| Workspace conversation history | `~/.buli/sessions/<workspace-id>/sessions.sqlite` |
| Project instructions | `.buli/` inside the workspace |

The workspace ID is derived from the canonical workspace path. Credentials and
conversation history are not encrypted by Buli. Credentials use private POSIX
permissions, but remain readable by processes with sufficient local access.
Treat session files as sensitive: they can contain code, tool results, and images.

Logout removes local credentials; it does not sign your browser out or revoke
copies stored elsewhere.

Large tool outputs can be retained in temporary storage and read in pages through
`tool_output`. That storage expires when Buli closes. A saved output ID cannot
retrieve the original content after restart; the source tool must be run again.
Pages already read into the conversation may remain in its saved history.

## Updates

For npm installations:

```bash
npm install --global @ukibbb/buli@latest
```

For standalone installations:

```bash
buli update --check
buli update
```

The standalone updater verifies the downloaded release before replacing the
installation. It does not modify package-manager installations.

Release candidates, when published, are available through:

```bash
npm install --global @ukibbb/buli@next
```

## Development

To run from source, install:

- [Bun](https://bun.sh) 1.3.12 or newer;
- [ripgrep](https://github.com/BurntSushi/ripgrep), available as `rg`;
- [fd](https://github.com/sharkdp/fd), available as `fd`.

```bash
git clone https://github.com/ukibbb/buliV2.git
cd buliV2
bun install
bun run dev
```

`bun run dev` starts Buli with the OpenTUI debug console visible. Use `Ctrl+D`
to toggle the console. For watch mode without opening the console at startup,
use `bun run dev:quiet`.

Run the checks:

```bash
bun run typecheck
bun run test
```

Further documentation:

- [Release process](docs/releasing.md)
- [OpenAI models and context budgets](docs/openai-models.md)
- [Terminal rendering conventions](docs/opentui-rendering.md)

For bug reports, include the Buli version, operating system, terminal, provider,
and reproduction steps. Remove credentials and private conversation content
before sharing logs or screenshots.

## License

[MIT](LICENSE). Third-party attributions are listed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
