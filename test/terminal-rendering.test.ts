import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"

import { terminalParserOptions } from "@/terminal/parsers"
import { syntax, theme } from "@/terminal/theme"

test("defines pinned Python and Bash Tree-sitter parsers", () => {
  expect(terminalParserOptions).toEqual([
    {
      filetype: "python",
      aliases: ["py", "pyi"],
      wasm:
        "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.23.6/tree-sitter-python.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/tree-sitter/tree-sitter-python/v0.23.6/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "bash",
      aliases: ["sh", "zsh", "ksh"],
      wasm:
        "https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.0/tree-sitter-bash.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/tree-sitter/tree-sitter-bash/v0.25.0/queries/highlights.scm",
        ],
      },
    },
  ])
})

test("resolves detailed syntax scopes through the shared palette", () => {
  const importKeyword = syntax.getStyle("keyword.import")
  const unknownKeyword = syntax.getStyle("keyword.unknown")
  const comment = syntax.getStyle("comment")
  const inlineCode = syntax.getStyle("markup.raw")

  expect(importKeyword?.fg?.equals(RGBA.fromHex(theme.violet))).toBe(true)
  expect(unknownKeyword?.fg?.equals(RGBA.fromHex(theme.pink))).toBe(true)
  expect(comment?.fg?.equals(RGBA.fromHex(theme.textSubtle))).toBe(true)
  expect(comment?.italic).toBe(true)
  expect(inlineCode?.fg?.equals(RGBA.fromHex(theme.cyan))).toBe(true)
  expect(inlineCode?.bg?.equals(RGBA.fromHex(theme.surfaceRaised))).toBe(true)
})
