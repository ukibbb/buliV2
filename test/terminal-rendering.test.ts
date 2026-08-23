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

test("keeps the classic Buli palette", () => {
  expect(theme).toEqual({
    amber: "#F59E0B",
    red: "#EF4444",
    green: "#10B981",
    pink: "#EC4899",
    surface: "#0F172A",
    text: "#E5E7EB",
    textMuted: "#94A3B8",
  })
})

test("styles detailed code and markdown scopes with the classic palette", () => {
  expect(syntax.getStyle("spell")?.fg).toBeUndefined()
  expect(syntax.getStyle("nospell")?.fg).toBeUndefined()
  expect(syntax.getStyle("none")?.fg).toBeUndefined()
  expect(syntax.getStyle("keyword.conditional.ternary")?.fg?.equals(
    RGBA.fromHex(theme.pink),
  )).toBe(true)
  expect(syntax.getStyle("keyword.unknown")?.fg?.equals(
    RGBA.fromHex(theme.pink),
  )).toBe(true)
  expect(syntax.getStyle("function.method.call")?.fg?.equals(
    RGBA.fromHex(theme.green),
  )).toBe(true)
  expect(syntax.getStyle("type.builtin")?.fg?.equals(
    RGBA.fromHex(theme.amber),
  )).toBe(true)
  expect(syntax.getStyle("keyword.exception")?.fg?.equals(
    RGBA.fromHex(theme.red),
  )).toBe(true)

  const comment = syntax.getStyle("comment.documentation")
  expect(comment?.fg?.equals(RGBA.fromHex(theme.textMuted))).toBe(true)
  expect(comment?.italic).toBe(true)

  const heading = syntax.getStyle("markup.heading.1")
  expect(heading?.fg?.equals(RGBA.fromHex(theme.amber))).toBe(true)
  expect(heading?.bold).toBe(true)
  expect(heading?.underline).toBe(true)

  const inlineCode = syntax.getStyle("markup.raw")
  expect(inlineCode?.fg?.equals(RGBA.fromHex(theme.amber))).toBe(true)
  expect(inlineCode?.bg?.equals(RGBA.fromHex(theme.surface))).toBe(true)

  const link = syntax.getStyle("markup.link.url")
  expect(link?.fg?.equals(RGBA.fromHex(theme.textMuted))).toBe(true)
  expect(link?.underline).toBe(true)
  expect(link?.dim).toBe(true)
})
