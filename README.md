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
- use `/new` to return to a fresh Home screen
- use `/sessions` to reopen a saved conversation
- use `/model` and `/reasoning` to change the next run configuration
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

## Session persistence

Buli stores multiple conversations per workspace. The app starts on Home without creating a session; the first non-empty prompt creates one, using that prompt as its title. Completed messages and session metadata are appended to a JSONL file under `~/.buli/sessions/`; the filename is the SHA-256 hash of the canonical workspace path.

On restart, saved sessions are available through `/sessions`. Opening one restores its completed turns for the next model request. `/clear` removes the conversation history but keeps the session entry. In-progress assistant snapshots are kept only in memory, so a process crash can lose the unfinished response without growing the JSONL file once per streamed token.

Run only one Buli process per workspace. Concurrent writers are not currently supported for the shared workspace session log.

If a crash or watch restart leaves the terminal in a strange state, run:

```bash
reset
```
