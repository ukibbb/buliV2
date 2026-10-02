import { expect, test } from "bun:test"
import { defineAgentTool, ToolAccess, type IAgentModelRequest } from "@/agent"
import { AgentSession } from "@/sessions/agent-session"
import { SQLiteSessionManager } from "@/sessions/sqlite/sqlite-session-manager"
import { estimateContextUsage } from "@/sessions/compaction/context-budget"

for (const sideBranch of [false, true]) {
    test(`opening a session enforces the active branch tool policy (side: ${sideBranch})`, async () => {
        const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
        manager.createSession({ id: "session", agentId: "agent", title: "Test", createdAt: 1, updatedAt: 1 })
        if (sideBranch) manager.createBranch("session", "side")
        const executed: string[] = []
        const requests: IAgentModelRequest[] = []
        const tools = [ToolAccess.ReadOnly, ToolAccess.MayMutate, undefined].map((access, index) => defineAgentTool({
            name: `tool_${index}`,
            description: `Tool ${index}`,
            inputSchema: { type: "object", additionalProperties: false },
            ...(access === undefined ? {} : { access }),
            async execute() {
                executed.push(`tool_${index}`)
                return "done"
            },
        }))
        const expectedTools = sideBranch ? tools.slice(0, 1) : tools
        const session = new AgentSession({
            agentId: "agent",
            sessionId: "session",
            manager,
            systemPrompt: "System",
            tools,
            resolveRunConfiguration: () => ({
                reasoningEffort: "medium",
                model: {
                    async *stream(request) {
                        requests.push(request)
                        if (requests.length === 1) {
                            for (const tool of tools) {
                                yield { type: "tool-call", toolCallId: `call_${tool.name}`, toolName: tool.name, input: {} }
                            }
                            yield { type: "finish", reason: "tool-calls" }
                            return
                        }
                        yield { type: "finish", reason: "stop" }
                    },
                },
            }),
        })
        try {
            expect(session.state.tools).toEqual(expectedTools)
            expect(session.getSnapshot().contextUsage).toEqual(estimateContextUsage({
                systemPrompt: "System", messages: [], tools: expectedTools,
            }))
            await session.prompt("Try every tool").runFinished
            expect(requests.length).toBeGreaterThan(0)
            for (const request of requests) {
                expect(request.tools.map((tool) => tool.name)).toEqual(expectedTools.map((tool) => tool.name))
            }
            expect(executed).toEqual(expectedTools.map((tool) => tool.name))
            expect(session.getSnapshot().contextUsage).toEqual(estimateContextUsage({
                systemPrompt: "System", messages: manager.loadRequiredContext("session").messages, tools: expectedTools,
            }))
        } finally {
            await session.dispose()
        }
    })
}
