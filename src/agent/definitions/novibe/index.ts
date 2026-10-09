import { createAgentDefinition } from "@/agent/create-agent-definition"
import type { IRuntimeAgentTool } from "@/agent/tool"
import type { IToolOutputStore } from "@/agent/tool-output-store"
import { ReadTool } from "@/agent/tools/read/read-tool"
import { FindTool } from "@/agent/tools/find/find-tool"
import { GrepTool } from "@/agent/tools/grep/grep-tool"
import { ReadToolOutputTool } from "@/agent/tools/read-tool-output/read-tool-output-tool"

/** Local capabilities only; the session must obtain its role from MCP before generation. */
export function createNovibeAgentDefinition(dependencies: {
    readonly workspaceRoot: string
    readonly toolOutputStore: IToolOutputStore
    readonly fdExecutablePath?: string
    readonly ripgrepExecutablePath?: string
}, additionalTools: readonly IRuntimeAgentTool[]) {
    return createAgentDefinition({
        id: "novibe",
        name: "NoVibe",
        instructions: "",
        tools: [
            ReadTool, FindTool, GrepTool, ReadToolOutputTool,
            ...additionalTools.map((tool) => ({
                name: tool.name,
                instructions: [],
                create: () => tool,
            })),
        ],
    }, dependencies)
}
