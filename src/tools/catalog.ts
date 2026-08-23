import type { IAgentTool } from "@/agent"
import { createBashTool } from "@/tools/command/bash-tool"
import { createRequestPatchHandoffTool } from "@/tools/handoff/request-patch-handoff-tool"
import { createWorkspacePathResolver } from "@/tools/paths"
import { createApplyPatchTool } from "@/tools/patch/apply-patch-tool"
import { createReadTool } from "@/tools/read/read-tool"
import { createGlobTool } from "@/tools/search/glob-tool"
import { createGrepTool } from "@/tools/search/grep-tool"
import { createRipgrepExecutableResolver } from "@/tools/search/ripgrep"

/** Composes the model-facing tools that operate on one workspace. */
export function createWorkspaceTools(
    workspaceRoot: string,
    options: {
        readonly ripgrepExecutablePath?: string
        readonly ripgrepSearchPath?: string
        readonly ripgrepPathExt?: string
    } = {},
): readonly IAgentTool[] {
    const resolveWorkspacePath = createWorkspacePathResolver(workspaceRoot)
    const resolveRipgrepExecutable = createRipgrepExecutableResolver(
        workspaceRoot,
        {
            ...(options.ripgrepExecutablePath === undefined
                ? {}
                : { executablePath: options.ripgrepExecutablePath }),
            ...(options.ripgrepSearchPath === undefined
                ? {}
                : { searchPath: options.ripgrepSearchPath }),
            ...(options.ripgrepPathExt === undefined
                ? {}
                : { pathExt: options.ripgrepPathExt }),
        },
    )

    return [
        createReadTool(resolveWorkspacePath),
        createGlobTool(resolveWorkspacePath, resolveRipgrepExecutable),
        createGrepTool(resolveWorkspacePath, resolveRipgrepExecutable),
        createRequestPatchHandoffTool(),
        createApplyPatchTool(workspaceRoot),
        createBashTool(workspaceRoot),
    ]
}
