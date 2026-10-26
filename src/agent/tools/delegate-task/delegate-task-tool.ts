import { Type } from "typebox"
import { defineAgentTool, type IAgentToolContext } from "@/agent/tools/tool"
import { ToolAccess } from "@/agent/tools/tool-policy"
import type { IAgentDefinition } from "@/agent/definitions/definition"

export function createDelegateTaskTool(run: (tasks: readonly { readonly task: string }[], context: IAgentToolContext) => Promise<string>) {
    return defineAgentTool({
        name: "delegate_task",
        description: "Optionally delegate 1–3 independent codebase research tasks to read-only Explorers. Tasks run concurrently; results return in input order after all finish. Provide each Explorer with a self-contained question, relevant context and expected output. They do not receive your conversation or MCP tools. Use only when isolated research is useful, not to fill the task limit. Model and reasoning effort are inherited.",
        access: ToolAccess.ReadOnly,
        inputSchema: Type.Object({
            tasks: Type.Array(Type.Object({ task: Type.String({ minLength: 1 }) }), { minItems: 1, maxItems: 3 }),
        }),
        execute: async ({ tasks }, context) => {
            if (tasks.some(({ task }) => !task.trim())) throw new Error("Research tasks cannot be blank")
            return run(tasks, context)
        },
    })
}

/** An agent the main agents may hand tasks to, with when to use it. */
export interface IDelegatableAgent {
    readonly definition: IAgentDefinition
    readonly description: string
}

/** Delegates to configured subagents; they may change files, so the tool stays out of read-only branches. */
export function createRunAgentTool(
    agents: readonly IDelegatableAgent[],
    run: (tasks: readonly { readonly agent: string; readonly task: string }[], context: IAgentToolContext) => Promise<string>,
) {
    return defineAgentTool({
        name: "run_agent",
        description: [
            "Delegate 1–3 self-contained tasks to configured subagents. They run concurrently and return reports in input order after all finish. They do not receive your conversation; give each the full task, files and expected output. Model and reasoning effort are inherited. Agents:",
            ...agents.map((agent) => `- ${agent.definition.id}: ${agent.description}`),
        ].join("\n"),
        access: ToolAccess.MayMutate,
        inputSchema: Type.Object({
            tasks: Type.Array(Type.Object({
                agent: Type.Union(agents.map((agent) => Type.Literal(agent.definition.id))),
                task: Type.String({ minLength: 1 }),
            }), { minItems: 1, maxItems: 3 }),
        }),
        execute: async ({ tasks }, context) => {
            if (tasks.some(({ task }) => !task.trim())) throw new Error("Agent tasks cannot be blank")
            return run(tasks, context)
        },
    })
}
