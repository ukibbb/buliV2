import { expect, test } from "bun:test"

import { parseAnsiLines } from "@/ui/terminal/ansi-text"

test("splits lines and keeps truecolor, bold, and dim styles until reset", () => {
  const output = "\x1b[38;2;59;130;246mGPT-5\x1b[0m \x1b[1;2mctx\x1b[22m 23%\n\x1b[48;2;10;58;38m 5H \x1b[0m\n"

  expect(parseAnsiLines(output)).toEqual([
    [{ text: "GPT-5", fg: "#3b82f6" }, { text: " " }, { text: "ctx", bold: true, dim: true }, { text: " 23%" }],
    [{ text: " 5H ", bg: "#0a3a26" }],
  ])
})

test("maps basic and 256-color codes and drops other escapes", () => {
  const output = "\x1b[31mred\x1b[39m \x1b[38;5;196mhot\x1b[0m\x1b]8;;https://x.dev\x07link\x1b]8;;\x07\x1b[2K"

  expect(parseAnsiLines(output)).toEqual([
    [{ text: "red", fg: "#cd0000" }, { text: " " }, { text: "hot", fg: "#ff0000" }, { text: "link" }],
  ])
})

test("keeps empty lines between content and ignores a malformed color", () => {
  expect(parseAnsiLines("a\n\nb\x1b[38;2;1mc")).toEqual([
    [{ text: "a" }],
    [],
    [{ text: "b" }, { text: "c" }],
  ])
})

test("CRLF line endings keep escapes aligned with their text", () => {
  expect(parseAnsiLines("ab\r\ncd\x1b[31mred\x1b[0m end")).toEqual([
    [{ text: "ab" }],
    [{ text: "cd" }, { text: "red", fg: "#cd0000" }, { text: " end" }],
  ])
})
