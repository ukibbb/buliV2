# Buli

Small Bun project for the Buli terminal app.

## Terminal app development

Run the app in restart-on-save mode from the project root:

```bash
bun run dev
```

That runs `cli/main.ts` with Bun watch and opens the OpenTUI console overlay so `console.log`, `console.debug`, `console.warn`, and `console.error` are visible while the TUI owns the terminal screen.

Inside the TUI:

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

If a crash or watch restart leaves the terminal in a strange state, run:

```bash
reset
```
