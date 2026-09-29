import { expect, test } from "bun:test"
import { defineAgentTool, ToolAccess, type IAgentToolContext } from "@/agent"
import type { ISessionConfiguration } from "@/sessions/agent-session"
import { SessionMcpController } from "@/mcp/session-mcp-controller"

const context: IAgentToolContext = {
    sessionId: "session", toolCallId: "call", runId: "run",
    signal: new AbortController().signal,
}

function fixture() {
    const configurations: ISessionConfiguration[] = []
    let rejectUpdate = false
    let rejectExecution = false
    let executions = 0
    const tool = defineAgentTool({
        name: "novibe__read_note", description: "Read note",
        inputSchema: { type: "object", additionalProperties: false },
        access: ToolAccess.ReadOnly,
        async execute() { executions += 1; return "note" },
    })
    const controller = new SessionMcpController({
        baseConfiguration: { systemPrompt: "Base", tools: [] },
        applyConfiguration(configuration) {
            if (rejectUpdate) throw new Error("Session busy")
            configurations.push(configuration)
        },
        assertToolExecutionAllowed() {
            if (rejectExecution) throw new Error("Execution denied")
        },
    })
    return {
        controller, configurations, tool,
        contribution: { instructions: "Notes", tools: [tool] },
        rejectUpdates: (value: boolean) => { rejectUpdate = value },
        denyExecution: () => { rejectExecution = true },
        executions: () => executions,
    }
}

test("MCP is inactive by default and activation is idempotent", () => {
    const { controller, configurations, contribution } = fixture()
    expect(controller.isActive("novibe")).toBe(false)
    expect(configurations).toHaveLength(0)
    controller.activate("novibe", contribution)
    controller.activate("novibe", contribution)
    expect(configurations).toHaveLength(1)
    expect(configurations[0]?.systemPrompt).toBe("Base\n\nNotes")
    controller.deactivate("novibe")
    expect(configurations.at(-1)).toEqual({ systemPrompt: "Base", tools: [], activeMcpServerIds: [] })
    controller.deactivate("novibe")
    expect(configurations).toHaveLength(2)
})

test("deactivation permanently revokes old executors even after reactivation", async () => {
    const f = fixture()
    f.controller.activate("novibe", f.contribution)
    const oldTool = f.configurations.at(-1)!.tools[0]!
    expect(await oldTool.validateAndExecute({}, context)).toBe("note")
    f.controller.deactivate("novibe")
    await expect(oldTool.validateAndExecute({}, context)).rejects.toThrow("inactive")
    f.controller.activate("novibe", f.contribution)
    await expect(oldTool.validateAndExecute({}, context)).rejects.toThrow("inactive")
    const currentTool = f.configurations.at(-1)!.tools[0]!
    expect(await currentTool.validateAndExecute({}, context)).toBe("note")
    f.denyExecution()
    await expect(currentTool.validateAndExecute({}, context)).rejects.toThrow("Execution denied")
    expect(f.executions()).toBe(2)
})

test("rejected activation and deactivation preserve the previous registration", async () => {
    const f = fixture()
    f.rejectUpdates(true)
    expect(() => f.controller.activate("novibe", f.contribution)).toThrow("Session busy")
    expect(f.controller.isActive("novibe")).toBe(false)
    f.rejectUpdates(false)
    f.controller.activate("novibe", f.contribution)
    const tool = f.configurations.at(-1)!.tools[0]!
    f.rejectUpdates(true)
    expect(() => f.controller.deactivate("novibe")).toThrow("Session busy")
    expect(f.controller.isActive("novibe")).toBe(true)
    expect(await tool.validateAndExecute({}, context)).toBe("note")
})

test("conflicts reject activation without removing existing contributions", () => {
    const f = fixture()
    f.controller.activate("novibe", f.contribution)
    expect(() => f.controller.activate("other", f.contribution)).toThrow("Duplicate tool name")
    expect(f.controller.isActive("other")).toBe(false)
    expect(f.controller.isActive("novibe")).toBe(true)
    expect(f.configurations).toHaveLength(1)
})

test("disposing revokes executors without updating the closing session", async () => {
    const f = fixture()
    f.controller.activate("novibe", f.contribution)
    const tool = f.configurations.at(-1)!.tools[0]!
    f.controller.dispose()
    f.controller.dispose()
    expect(f.controller.isActive("novibe")).toBe(false)
    await expect(tool.validateAndExecute({}, context)).rejects.toThrow("inactive")
    expect(() => f.controller.activate("novibe", f.contribution)).toThrow("disposed")
    expect(f.configurations).toHaveLength(1)
})

test("controllers keep activation isolated between sessions", () => {
    const first = fixture()
    const second = fixture()
    first.controller.activate("novibe", first.contribution)
    expect(second.controller.isActive("novibe")).toBe(false)
    expect(second.configurations).toHaveLength(0)
})
