import { isAbsolute, resolve } from "node:path"

import type { IToolCallContent } from "@/agent"

/** Claude Code tool names for Buli tools, so hook matchers such as `Bash|Write|Edit` apply. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
    read: "Read",
    write: "Write",
    edit: "MultiEdit",
    bash: "Bash",
    grep: "Grep",
    find: "Glob",
    delegate_task: "Task",
    web_search: "WebSearch",
}

/** Buli tools whose `path` input Claude Code reads as an absolute `file_path`. */
const FILE_PATH_TOOLS = new Set(["read", "write", "edit"])

/** A Buli tool call as Claude Code names and shapes it. */
export interface IClaudeToolCall {
    readonly name: string
    readonly input: Record<string, unknown>
}

/** Claude Code reads `file_path` as an absolute path and Edit fields as `old_string`/`new_string`. */
export function toClaudeToolCall(call: IToolCallContent, workspaceRoot: string): IClaudeToolCall {
    const name = CLAUDE_TOOL_NAMES[call.toolName] ?? call.toolName
    const { path, edits, ...rest } = call.input
    if (typeof path !== "string" || !FILE_PATH_TOOLS.has(call.toolName)) {
        return { name, input: call.input }
    }
    const file_path = isAbsolute(path) ? path : resolve(workspaceRoot, path)
    if (call.toolName !== "edit" || !Array.isArray(edits)) return { name, input: { ...rest, file_path } }
    return {
        name,
        input: {
            ...rest,
            file_path,
            edits: edits.map((edit: { oldText?: unknown; newText?: unknown }) => ({
                old_string: edit.oldText,
                new_string: edit.newText,
            })),
        },
    }
}
