# OpenTUI rendering

Buli currently targets OpenTUI 0.5.10. This document records the rendering
choices that are easy to lose when adding screens or upgrading OpenTUI.

## Temporary diff rendering patch

`patches/@opentui%2Fcore@0.5.10.patch` backports the background paint-window
fix from [OpenTUI PR #1462](https://github.com/anomalyco/opentui/pull/1462)
(merge commit `fccce4ec138aaa1ce6ded846adf1d844394e6f8b`). The upstream fix was
merged on 2026-09-02 but is not included in the published 0.5.10 release. Remove
this temporary patch once upgrading to a release that contains the fix; do not
assume a particular next release number.

Without the patch, `LineNumberRenderable` paints backgrounds for rows above
the screen. Bun's unsigned `fillRect` coordinates clamp negative Y to zero,
leaving a green or red strip at the top of the transcript. The patch bounds
background painting to destination-buffer rows in both the Bun and Node
entrypoints, preserving line numbers, colors, wrapping, and scroll extent.
It does not backport the rest of #1462's performance changes.

Both `@opentui/core` and `@opentui/react` are pinned to 0.5.10 while this patch
is required. Bun applies it automatically through `patchedDependencies`,
including with `bun install --frozen-lockfile` in CI and release builds.

When removing the patch:

1. Verify that the target OpenTUI release includes #1462 or an equivalent fix.
2. Upgrade `@opentui/core` and `@opentui/react` together to the same release.
3. Remove the patch file and its `patchedDependencies` entry from `package.json`,
   then run `bun install` to regenerate `bun.lock`.
4. Keep the scrolling regression in `src/ui/sessions/Transcript.test.tsx` and verify it
   passes without the patch, including background colors, numbered text,
   scrolling back, and narrow resizing for proposals and Markdown diffs.
5. Run `bun run typecheck`, `bun run test`, and a compiled CLI smoke test.

## Theme and layout

- `src/ui/terminal/theme.ts` is the only source of shared UI and syntax colors.
- Root views leave unused cells transparent within the render tree, while the
  shared renderer clears them to `theme.surface` (`#000000`). The application
  deliberately uses a black background rather than inheriting the terminal's
  background, with the original green, amber, pink, and red accents.
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

OpenTUI includes the TypeScript parser. `src/ui/terminal/parsers.ts` registers
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
