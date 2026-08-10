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

- press `Escape` to stop the active response
- press `Ctrl+L` to toggle the console
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

## Session persistence

Buli stores one continuous `default` conversation per workspace. Completed messages are appended to a JSONL file under `~/.buli/sessions/`; the filename is the SHA-256 hash of the canonical workspace path.

On restart, completed turns are restored and included in the next model request. In-progress assistant snapshots are kept only in memory, so a process crash can lose the unfinished response without growing the JSONL file once per streamed token.

If a crash or watch restart leaves the terminal in a strange state, run:

```bash
reset
```
