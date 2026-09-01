# OpenTUI rendering

Buli currently targets OpenTUI 0.5.8. This document records the rendering
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
- Host-injected tools may use one scrollable command-approval panel. Built-in
  Bash consent happens in the conversation and does not open that panel. The
  built-in OpenTUI console keeps its default colors and chrome.

## Syntax highlighting

`syntax` is a single `SyntaxStyle` instance shared by Markdown, fenced code,
and host-injected command approvals. It covers the detailed Tree-sitter
scopes for comments, constants, functions, keywords, operators, punctuation,
strings, types, variables, and Markdown markup while using only the classic
Buli palette. Scope fallback still lets unknown subtypes inherit their broader
token style.

Markdown keeps OpenTUI's native renderer and top-level streaming block reuse.
Headings, emphasis, links, lists, quotes, inline code, and fenced code therefore
receive syntax styling. A code-block-only `renderNode` callback converts valid,
closed `diff` fenced blocks into OpenTUI's unified diff viewer. Incomplete
streaming blocks and structurally malformed patches retain the native code-block
fallback. Inaccurate hunk counts are corrected only in the render input; stored
assistant text remains unchanged.
Other fenced code does not add a card, background, or padding. Tables use the
full available width, proportional columns, word wrapping, and the muted
single-line grid.

Host-injected command approvals render their preview as Bash code. Built-in
Bash consent remains conversational. File-change proposals render their stored
unified diff directly in the transcript and do not open a separate modal.

Durable proposal diffs are inserted after the assistant tool call that created
them and before the next later message. A live proposal is rendered only until
its durable record appears. The latest compaction checkpoint is rendered as a
Markdown summary immediately after its `throughMessageId` anchor, while the
status row shows an animated `Compacting context` state during generation.

OpenTUI includes the TypeScript parser. `src/terminal/parsers.ts` registers
tag-pinned Python 0.23.6 and Bash 0.25.0 WASM grammars and highlight queries
from embedded assets before the shared Tree-sitter client starts. A failed or
unknown parser still displays unstyled content.

## Component map

| Primitive | Buli usage |
| --- | --- |
| `<box>` and `<text>` | Layout, command menus, borders, semantic text, and rich text spans |
| `<scrollbox>` | Session transcript, approval review, and authentication content |
| `<textarea>` | Multiline chat prompt |
| `<input>` | Manual authentication callback entry |
| `<select>` | Authentication choices |
| `<markdown>` | Assistant responses and tool output with shared syntax highlighting |
| `<code>` | Native fenced blocks and host-injected command approval previews |
| `<diff>` | Valid assistant `diff` fences and file-change proposal records |
| `<a>` | Clickable authentication URLs while preserving visible fallback text |

## Reserved primitives

These OpenTUI capabilities should be introduced only with the corresponding
product behavior:

- `<image>`: message attachments or tool results that carry image data. Define
  terminal capability fallback and size limits before rendering binary content.
- `<line-number>`: a dedicated source-file viewer. The current proposal and
  Markdown diff viewers already render their own patch line numbers.
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
