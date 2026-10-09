import { expect, test } from "bun:test"
import { createDelegateTaskTool } from "@/agent/tools/delegate-task/delegate-task-tool"

const context = { sessionId: "parent", runId: "run", toolCallId: "call", signal: new AbortController().signal }

test("delegation accepts one to three tasks and rejects blank or oversized groups", async () => {
    const sizes: number[] = []
    const tool = createDelegateTaskTool(async (tasks) => { sizes.push(tasks.length); return "done" })
    for (const size of [1, 2, 3]) {
        await tool.validateAndExecute({ tasks: Array.from({ length: size }, () => ({ task: "Inspect code" })) }, context)
    }
    expect(sizes).toEqual([1, 2, 3])
    for (const tasks of [[], [{ task: "   " }], Array.from({ length: 4 }, () => ({ task: "Inspect" }))]) {
        await expect(tool.validateAndExecute({ tasks }, context)).rejects.toThrow()
    }
    expect(sizes).toEqual([1, 2, 3])
})
