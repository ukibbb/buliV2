import { expect, test } from "bun:test"
import { defineAgentTool, ToolAccess, type IAgentToolContext } from "@/agent"
import { AgentSession } from "@/sessions/agent-session"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
import { SessionMcpController } from "@/mcp/session-mcp-controller"

function createSession(id: string) {
    const manager = new InMemorySessionManager()
    manager.createSession({ id, agentId: "agent", title: "Test", createdAt: 1, updatedAt: 1 })
    const session = new AgentSession({
        agentId: "agent", sessionId: id, manager,
        systemPrompt: "Base", tools: [],
        resolveRunConfiguration: () => ({
            reasoningEffort: "medium",
            model: { async *stream() { yield { type: "finish", reason: "stop" } } },
        }),
    })
    const controller = new SessionMcpController({
        baseConfiguration: { systemPrompt: "Base", tools: [] },
        applyConfiguration: (configuration) => session.updateConfiguration(configuration),
        assertToolExecutionAllowed: (tool, context) => session.assertToolExecutionAllowed(tool, context),
    })
    return { session, controller }
}

test("real sessions enforce MCP execution policy without sharing activation", async () => {
    const first = createSession("first")
    const second = createSession("second")
    let executions = 0
    const tool = defineAgentTool({
        name: "novibe__write_note", description: "Write note",
        inputSchema: { type: "object", additionalProperties: false },
        access: ToolAccess.MayMutate,
        async execute() { executions += 1; return "saved" },
    })
    const context: IAgentToolContext = {
        sessionId: "first", runId: "run", toolCallId: "call",
        signal: new AbortController().signal,
    }
    try {
        expect(first.session.state.systemPrompt).toBe("Base")
        expect(first.session.state.tools).toEqual([])
        first.controller.activate("novibe", { instructions: "Notes", tools: [tool] })
        const executor = first.session.state.tools[0]!
        expect(second.session.state.systemPrompt).toBe("Base")
        expect(second.session.state.tools).toEqual([])
        expect(second.controller.isActive("novibe")).toBe(false)
        expect(await executor.validateAndExecute({}, context)).toBe("saved")
        await expect(executor.validateAndExecute({}, { ...context, sessionId: "second" }))
            .rejects.toThrow("another session")
        first.session.createBranch()
        expect(first.session.state.tools).toEqual([])
        await expect(executor.validateAndExecute({}, context)).rejects.toThrow("not allowed")
        first.session.returnToParentBranch()
        await expect(executor.validateAndExecute({}, {
            ...context, signal: AbortSignal.abort(new Error("Cancelled")),
        })).rejects.toThrow("Cancelled")
        expect(executions).toBe(1)
        await first.session.dispose()
        await expect(executor.validateAndExecute({}, context)).rejects.toThrow("disposed")
        first.controller.dispose()
        await expect(executor.validateAndExecute({}, context)).rejects.toThrow("inactive")
        expect(executions).toBe(1)
    } finally {
        first.controller.dispose()
        second.controller.dispose()
        await Promise.all([first.session.dispose(), second.session.dispose()])
    }
})
