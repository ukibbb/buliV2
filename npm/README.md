# Buli

An AI coding assistant for your terminal.

Explore a codebase, work on files, run commands, and resume conversations by
project. Connect OpenAI through ChatGPT/Codex, Kimi Code, or DeepSeek.

[Documentation](https://github.com/ukibbb/buliV2#readme) ·
[Releases](https://github.com/ukibbb/buliV2/releases) ·
[Report an issue](https://github.com/ukibbb/buliV2/issues)

## Installation

Requires **Node.js 18 or newer** and npm. Native releases support **macOS and
Linux on ARM64 and x64**. Bun is not required.

```bash
npm install --global @ukibbb/buli
buli --version
```

The package downloads the matching native release from GitHub, verifies its
published SHA-256 checksum, and installs the executable and private ripgrep and
fd binaries inside the npm package.

Choose either npm or the standalone installer described in the main
[README](https://github.com/ukibbb/buliV2#installation), not both, to avoid
multiple `buli` commands in your `PATH`.

## Quick start

Connect a provider:

```bash
buli login
```

Launch Buli from your project directory:

```bash
cd your-project
buli
```

Use `/model` to select a model, `/sessions` to reopen a conversation, and
`/branch` to explore a read-only side question. Add project conventions in
`.buli/BULI.md`; restart Buli after changing that file.

OpenAI uses ChatGPT/Codex OAuth, not `OPENAI_API_KEY`. Kimi Code and DeepSeek use
API keys. Model access, limits, and charges depend on your provider account.

## Safety

Buli is **not a sandbox**. File tools can access paths outside the project, and
shell commands run with your user account's permissions. Approval instructions
are conversational rules, not an enforced security boundary.

Conversation content may be sent to model providers. Local credentials and
history are not encrypted by Buli. Read the
[data and safety guide](https://github.com/ukibbb/buliV2#data-and-safety) before
working with sensitive code.

## Updates

Update npm-managed installations through npm:

```bash
npm install --global @ukibbb/buli@latest
```

Release candidates, when published, use the `next` tag:

```bash
npm install --global @ukibbb/buli@next
```

## License

[MIT](https://github.com/ukibbb/buliV2/blob/main/LICENSE).
