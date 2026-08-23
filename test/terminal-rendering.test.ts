import { expect, test } from "bun:test"

import { terminalParserOptions } from "@/terminal/parsers"
import { theme } from "@/terminal/theme"

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
