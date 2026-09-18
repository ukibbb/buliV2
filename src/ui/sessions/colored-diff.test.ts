import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"

import { colorDiffText } from "@/ui/sessions/colored-diff"
import { theme } from "@/ui/terminal/theme"

test.each(["", "-old\n+new", " context\n", "-żółć\r\n+🐍\r\n", "@@ fragment @@\nplain"])(
    "preserves diff text exactly: %j",
    (text) => {
        expect(colorDiffText(text).chunks.map((chunk) => chunk.text).join("")).toBe(text)
    },
)

test("colors changes and hunk headers without coloring context as a change", () => {
    const styled = colorDiffText("-old\n+new\n@@ fragment @@\n context\nplain\n +context")
    expect(styled.chunks.map((chunk) => chunk.fg?.equals(RGBA.fromHex(theme.text))))
        .toEqual([false, false, false, true, true, true])
    expect(styled.chunks[0]?.fg?.equals(RGBA.fromHex(theme.red))).toBe(true)
    expect(styled.chunks[1]?.fg?.equals(RGBA.fromHex(theme.green))).toBe(true)
    expect(styled.chunks[2]?.fg?.equals(RGBA.fromHex(theme.amber))).toBe(true)
})
