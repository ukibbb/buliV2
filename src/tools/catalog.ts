import type { IAgentTool } from "@/agent"
import { createBashTool } from "@/tools/command/bash-tool"
import {
    createSelectedPathResolver,
    createWorkspacePathResolver,
} from "@/tools/paths"
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
    const resolveSelectedPath = createSelectedPathResolver(workspaceRoot)
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
        createReadTool(resolveWorkspacePath, resolveSelectedPath),
        createGlobTool(
            resolveWorkspacePath,
            resolveRipgrepExecutable,
            resolveSelectedPath,
        ),
        createGrepTool(resolveWorkspacePath, resolveRipgrepExecutable),
        createApplyPatchTool(workspaceRoot),
        createBashTool(workspaceRoot),
    ]
}
