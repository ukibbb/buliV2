# OpenTUI rendering

Buli currently targets OpenTUI 0.5.6. This document records the rendering
choices that are easy to lose when adding screens or upgrading OpenTUI.

## Theme and layout

- `src/terminal/theme.ts` is the only source of shared UI and syntax colors.
- Root views leave unused cells transparent so the terminal retains its own
  background. The interface uses the original green, amber, pink, and red
  accents rather than a separate blue application palette.
- Home renders the fixed Buli text logo. The chat composer remains flush with
  the viewport: workspace path, bordered editor, horizontal status, and plain
  command list.
- `useTerminalDimensions()` keeps command-menu selection visible on short
  terminals. Authentication content uses a bounded scroll area for the same
  reason.
- Patch approvals use unified diffs at every terminal width. The built-in
  OpenTUI console keeps its default colors and chrome.

## Syntax highlighting

`syntax` is a single `SyntaxStyle` instance shared by Markdown, fenced code,
command approvals, and workspace diffs. It covers the detailed Tree-sitter
scopes for comments, constants, functions, keywords, operators, punctuation,
strings, types, variables, and Markdown markup while using only the classic
Buli palette. Scope fallback still lets unknown subtypes inherit their broader
token style.

Markdown keeps OpenTUI's native renderer and top-level streaming block reuse.
Headings, emphasis, links, lists, quotes, inline code, and fenced code therefore
receive syntax styling without a custom `renderNode` callback. Fenced code does
not add a card, background, or padding. Tables use the full available width,
proportional columns, word wrapping, and the muted single-line grid.

Command approvals render their preview as Bash code. Patch approvals choose the
diff parser from each file path and fall back to plain text when the extension
is unknown; they remain unified at every terminal width.

OpenTUI includes the TypeScript parser. `src/terminal/parsers.ts` registers
tag-pinned Python 0.23.6 and Bash 0.25.0 WASM grammars and highlight queries
before the shared Tree-sitter client starts. The first use can require network
access; OpenTUI caches the downloaded parser resources. A failed or unknown
parser still displays unstyled content.

## Component map

| Primitive | Buli usage |
| --- | --- |
| `<box>` and `<text>` | Layout, command menus, borders, semantic text, and rich text spans |
| `<scrollbox>` | Session transcript, approval review, and authentication content |
| `<textarea>` | Multiline chat prompt |
| `<input>` | Manual authentication callback entry |
| `<select>` | Authentication choices |
| `<markdown>` | Assistant responses and tool output with shared syntax highlighting |
| `<code>` | Native fenced blocks and Bash command approval previews |
| `<diff>` | Unified per-file workspace patches with path-based syntax highlighting |
| `<a>` | Clickable authentication URLs while preserving visible fallback text |

## Reserved primitives

These OpenTUI capabilities should be introduced only with the corresponding
product behavior:

- `<image>`: message attachments or tool results that carry image data. Define
  terminal capability fallback and size limits before rendering binary content.
- `<line-number>`: a dedicated source-file viewer. Existing `<diff>` already
  owns patch line numbers, so a separate gutter there would duplicate state.
- `<tab-select>`: persistent peer views, such as multiple open artifacts. The
  current command menu and authentication flow are actions, not tabs.
- `<ascii-font>`: responsive display type. Home intentionally uses a fixed text
  logo so it remains stable across terminal sizes.
- `extend()`: a custom renderable only when composition cannot provide the
  required drawing or input behavior. It also requires explicit lifecycle,
  focus, selection, resize, and test coverage.

When adding one of these primitives, test the renderable and its behavior
directly. Character-frame assertions should cover readable fallback content,
not a pixel-perfect copy of OpenTUI's internal drawing.
