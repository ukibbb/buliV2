import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"

import { truncateToolOutput } from "@/agent/tool-output"

test("keeps output that fits both limits", () => {
  const output = "first\nsecond\n"
  expect(truncateToolOutput(output, { maxBytes: 100, maxLines: 3 })).toBe(output)
})

test("truncates by UTF-8 bytes without splitting a code point", () => {
  const output = "😀".repeat(20)
  const truncated = truncateToolOutput(output, { maxBytes: 40, maxLines: 10 })

  expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(40)
  expect(truncated).toEndWith("... output preview ended")
  expect(truncated).not.toContain("�")
})

test("truncates by complete line count and remains idempotent", () => {
  const output = ["one", "two", "three", "four"].join("\n")
  const truncated = truncateToolOutput(output, { maxBytes: 100, maxLines: 3 })

  expect(truncated).toBe("one\ntwo\n... output preview ended")
  expect(truncateToolOutput(truncated, { maxBytes: 100, maxLines: 3 })).toBe(
    truncated,
  )
})
