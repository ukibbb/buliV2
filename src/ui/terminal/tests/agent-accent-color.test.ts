import { expect, test } from "bun:test"
import { agentAccentColor } from "../agent-accent-color"
import { theme } from "../theme"

test("conversation accent follows the selected agent in both directions", () => {
    expect(agentAccentColor(undefined)).toBe(theme.pink)
    expect(agentAccentColor("buli")).toBe(theme.pink)
    expect(agentAccentColor("buli-yolo")).toBe(theme.amber)
    expect(agentAccentColor("buli")).toBe(theme.pink)
    expect(agentAccentColor("novibe")).toBe(theme.pink)
})
