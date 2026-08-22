# OpenTUI rendering

Buli currently targets OpenTUI 0.5.6. This document records the rendering
choices that are easy to lose when adding screens or upgrading OpenTUI.

## Theme and layout

- `src/terminal/theme.ts` is the only source of UI colors, syntax colors, and
  shared glyphs.
- The renderer, root viewport, and top-level screens fill unused cells with
  `theme.background`. Raised or interactive content uses `surface`,
  `surfaceRaised`, or `surfaceSelected`.
- Every selectable control that exposes selection colors supplies the shared
  foreground and background. OpenTUI 0.5.6 does not expose selection colors
  for ordinary Markdown blocks; its configurable Markdown tables use the Buli
  colors. Focus is conveyed with green or amber rather than a second palette.
- `useTerminalDimensions()` owns responsive decisions. Home selects the
  `huge`, `block`, or `tiny` ASCII font from the available width and height.
  Patch previews use a synchronized split diff above 120 columns and a unified
  diff otherwise. Opening a command menu hides the logo, caps the editor, and
  sizes the option window from the terminal height.
- The built-in OpenTUI console has the same semantic log, surface, cursor,
  selection, title, and copy-button colors as the application.

## Syntax highlighting

`syntax` is a single `SyntaxStyle.fromTheme()` instance shared by Markdown,
code blocks, command previews, and diffs. It maps the Tree-sitter scopes used
by Markdown, TypeScript, Python, and Bash. OpenTUI resolves an unknown detailed
scope through its first segment and then through `default`, so both specific
and broad token names belong in the theme.

OpenTUI includes the TypeScript parser. `src/terminal/parsers.ts` registers
tag-pinned Python 0.23.6 and Bash 0.25.0 WASM grammars and highlight queries
before the shared Tree-sitter client starts. The first use can require network
access; OpenTUI caches the downloaded parser resources. A failed or unknown
parser still displays unstyled content, and extensionless diffs explicitly use
`plaintext`.

## Component map

| Primitive | Buli usage |
| --- | --- |
| `<box>` and `<text>` | Layout, borders, semantic text, and rich text spans |
| `<scrollbox>` | Session transcript, approval review, and the bounded authentication card body |
| `<textarea>` | Multiline chat prompt with shared cursor and selection colors |
| `<input>` | Manual authentication callback entry |
| `<select>` | Command menus and authentication choices |
| `<markdown>` | Assistant responses and tool output with shared syntax highlighting |
| `<code>` | Bash command approval with the Bash Tree-sitter parser |
| `<diff>` | Per-file workspace patches with syntax, line numbers, and semantic additions/removals |
| `<ascii-font>` | Responsive Home identity |
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
- `extend()`: a custom renderable only when composition cannot provide the
  required drawing or input behavior. It also requires explicit lifecycle,
  focus, selection, resize, and test coverage.

When adding one of these primitives, test the renderable and its behavior
directly. Character-frame assertions should cover readable fallback content,
not a pixel-perfect copy of OpenTUI's internal drawing.
