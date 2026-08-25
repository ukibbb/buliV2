/** Public API for workspace inspection and approval-gated actions. */
export { createWorkspaceTools } from "@/tools/catalog"
export { createBashTool } from "@/tools/command/bash-tool"
export { createApplyPatchTool } from "@/tools/patch/apply-patch-tool"
export { createFdPathSearcher } from "@/tools/search/fd-path-search"
export type {
    IFdPathSearchOptions,
    IFdPathSuggestion,
    TFdPathSearcher,
} from "@/tools/search/fd-path-search"
