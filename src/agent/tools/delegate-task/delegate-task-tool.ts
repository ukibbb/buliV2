import { Type } from "typebox"
import { defineAgentTool, type IAgentToolContext } from "@/agent/tool"
import { ToolAccess } from "@/agent/tool-policy"

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
