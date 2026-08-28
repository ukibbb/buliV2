import type { IAgentTool, IToolOutputStore } from "@/agent"
import { createBashTool } from "@/tools/command/bash-tool"
import { createEditTool } from "@/tools/edit/edit-tool"
import { createReadTool } from "@/tools/read/read-tool"
import { createFindTool } from "@/tools/search/find-tool"
import { createGrepTool } from "@/tools/search/grep-tool"
import { createWriteTool } from "@/tools/write/write-tool"

/** Composes the model-facing tools that operate on one workspace. */
export function createWorkspaceTools(
    workspaceRoot: string,
    options: {
        readonly fdExecutablePath?: string
        readonly ripgrepExecutablePath?: string
        readonly toolOutputStore?: IToolOutputStore
    } = {},
): readonly IAgentTool[] {
    return [
        createReadTool(workspaceRoot),
        createFindTool(workspaceRoot, options.fdExecutablePath),
        createGrepTool(workspaceRoot, options.ripgrepExecutablePath),
        createEditTool(workspaceRoot),
        createWriteTool(workspaceRoot),
        createBashTool(workspaceRoot, options.toolOutputStore),
    ]
}
