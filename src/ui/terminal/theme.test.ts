import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"

import { syntax, theme } from "@/ui/terminal/theme"

test("keeps the bright Buli palette", () => {
  expect(theme).toEqual({
    explorer: "#002575",
    amber: "#F59E0B",
    red: "#EF4444",
    green: "#10B981",
    pink: "#EC4899",
    surface: "#000000",
    text: "#FFFFFF",
    textSecondary: "#A3A3A3",
    violet: "#A78BFA",
  })
})

test("styles detailed code and markdown scopes with the shared palette", () => {
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
  expect(comment?.fg?.equals(RGBA.fromHex(theme.textSecondary))).toBe(true)
  expect(comment?.italic).toBe(true)

  const heading = syntax.getStyle("markup.heading.1")
  expect(heading?.fg?.equals(RGBA.fromHex(theme.amber))).toBe(true)
  expect(heading?.bold).toBe(true)
  expect(heading?.underline).toBe(true)

  const inlineCode = syntax.getStyle("markup.raw")
  expect(inlineCode?.fg?.equals(RGBA.fromHex(theme.amber))).toBe(true)
  expect(inlineCode?.bg?.equals(RGBA.fromHex(theme.surface))).toBe(true)

  const link = syntax.getStyle("markup.link.url")
  expect(link?.fg?.equals(RGBA.fromHex(theme.textSecondary))).toBe(true)
  expect(link?.underline).toBe(true)
  expect(link?.dim).toBe(true)
})
