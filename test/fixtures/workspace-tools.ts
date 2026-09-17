import type { IToolOutputStore } from "@/agent/tool-output-store"
import { createBashTool } from "@/agent/tools/bash/bash-tool"
import { createEditTool } from "@/agent/tools/edit/edit-tool"
import { createReadTool } from "@/agent/tools/read/read-tool"
import { createFindTool } from "@/agent/tools/find/find-tool"
import { createGrepTool } from "@/agent/tools/grep/grep-tool"
import type { FileChangeProposalStore } from "@/agent/tools/patch/file-change-proposal-store"
import {
    createApplyFileChangesTool,
} from "@/agent/tools/apply-file-changes/apply-file-changes-tool"
import {
    createRejectFileChangesTool,
} from "@/agent/tools/reject-file-changes/reject-file-changes-tool"
import { createWriteTool } from "@/agent/tools/write/write-tool"

export type TWorkspaceTool =
    | ReturnType<typeof createReadTool>
    | ReturnType<typeof createFindTool>
    | ReturnType<typeof createGrepTool>
    | ReturnType<typeof createEditTool>
    | ReturnType<typeof createWriteTool>
    | ReturnType<typeof createBashTool>
    | ReturnType<typeof createApplyFileChangesTool>
    | ReturnType<typeof createRejectFileChangesTool>

/** Broad tool fixture for execution and provider integration tests. */
export function createWorkspaceTools(
    workspaceRoot: string,
    options: {
        readonly fdExecutablePath?: string
        readonly ripgrepExecutablePath?: string
        readonly toolOutputStore?: IToolOutputStore
        readonly fileChangeProposalStore?: FileChangeProposalStore
    } = {},
): readonly TWorkspaceTool[] {
    const tools: TWorkspaceTool[] = [
        createReadTool(workspaceRoot),
        createFindTool(workspaceRoot, options.fdExecutablePath),
        createGrepTool(workspaceRoot, options.ripgrepExecutablePath),
        createEditTool(
            workspaceRoot,
            options.fileChangeProposalStore,
        ),
        createWriteTool(
            workspaceRoot,
            options.fileChangeProposalStore,
        ),
        createBashTool(workspaceRoot, options.toolOutputStore),
    ]
    if (options.fileChangeProposalStore) {
        tools.push(
            createApplyFileChangesTool(
                workspaceRoot,
                options.fileChangeProposalStore,
            ),
            createRejectFileChangesTool(options.fileChangeProposalStore),
        )
    }
    return tools
}
