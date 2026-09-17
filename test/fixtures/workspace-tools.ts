import type { IToolOutputStore } from "@/agent/tool-output-store"
import { createBashTool } from "@/agent/tools/bash/bash-tool"
import { createEditTool } from "@/agent/tools/edit/edit-tool"
import { createReadTool } from "@/agent/tools/read/read-tool"
import { createFindTool } from "@/agent/tools/find/find-tool"
import { createGrepTool } from "@/agent/tools/grep/grep-tool"
import { createWriteTool } from "@/agent/tools/write/write-tool"

export type TWorkspaceTool =
    | ReturnType<typeof createReadTool>
    | ReturnType<typeof createFindTool>
    | ReturnType<typeof createGrepTool>
    | ReturnType<typeof createEditTool>
    | ReturnType<typeof createWriteTool>
    | ReturnType<typeof createBashTool>

/** Broad tool fixture for execution and provider integration tests. */
export function createWorkspaceTools(
    workspaceRoot: string,
    options: {
        readonly fdExecutablePath?: string
        readonly ripgrepExecutablePath?: string
        readonly toolOutputStore?: IToolOutputStore
    } = {},
): readonly TWorkspaceTool[] {
    return [
        createReadTool(workspaceRoot),
        createFindTool(workspaceRoot, options.fdExecutablePath),
        createGrepTool(workspaceRoot, options.ripgrepExecutablePath),
        createEditTool(workspaceRoot),
        createWriteTool(workspaceRoot),
        createBashTool(workspaceRoot, options.toolOutputStore),
    ]
}
