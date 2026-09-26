import { expect, test } from "bun:test"
import { ToolAccess } from "@/agent/tool-policy"
import { createReadTool } from "@/agent/tools/read/read-tool"
import { createFindTool } from "@/agent/tools/find/find-tool"
import { createGrepTool } from "@/agent/tools/grep/grep-tool"
import { createReadToolOutputTool } from "@/agent/tools/read-tool-output/read-tool-output-tool"
import { createEditTool } from "@/agent/tools/edit/edit-tool"
import { createWriteTool } from "@/agent/tools/write/write-tool"
import { createBashTool } from "@/agent/tools/bash/bash-tool"
import { EphemeralToolOutputStore } from "@/agent/tools/output/ephemeral-tool-output-store"

test("built-in tools declare their access explicitly", async () => {
    const store = new EphemeralToolOutputStore()
    try {
        const readers = [createReadTool("."), createFindTool("."), createGrepTool("."), createReadToolOutputTool(store)]
        const writers = [createEditTool("."), createWriteTool("."), createBashTool(".")]
        for (const tool of readers) expect(tool.access).toBe(ToolAccess.ReadOnly)
        for (const tool of writers) expect(tool.access).toBe(ToolAccess.MayMutate)
    } finally {
        await store.dispose()
    }
})
