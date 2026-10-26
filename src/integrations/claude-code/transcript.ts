import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import type { TAgentMessage } from "@/agent"
import { claudeDirectory } from "@/integrations/claude-code/instructions"
import { toClaudeToolCall } from "@/integrations/claude-code/tool-calls"

/** Where Claude Code keeps a workspace's transcripts: every non-alphanumeric character of the path becomes `-`. */
export function claudeTranscriptPath(workspaceRoot: string, sessionId: string): string {
    return join(claudeDirectory(), "projects", workspaceRoot.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`)
}

/** Content blocks of a Claude Code message, the shapes buliOS hooks parse. */
type TClaudeContentBlock =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "thinking"; readonly thinking: string }
    | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
    | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string; readonly is_error: boolean }

/** One line of a Claude Code transcript as Buli writes it. */
interface IClaudeTranscriptEntry {
    readonly type: "user" | "assistant"
    readonly message:
        | { readonly role: "user"; readonly content: string | readonly TClaudeContentBlock[] }
        | { readonly role: "assistant"; readonly model: string; readonly content: readonly TClaudeContentBlock[] }
    readonly uuid: string
    readonly parentUuid: string | null
    readonly sessionId: string
    readonly timestamp: string
    readonly cwd: string
    readonly isSidechain: false
    readonly entrypoint: "buli"
}

/**
 * Appends a session's committed messages as Claude Code JSONL entries, so buliOS hooks and history
 * search read Buli conversations like Claude Code ones. A failed write never interrupts the session.
 * A resumed session continues the file with a new chain root, since earlier entries are not re-read.
 */
export class ClaudeTranscript {
    readonly path: string
    private parentUuid: string | null = null

    constructor(private readonly sessionId: string, private readonly workspaceRoot: string) {
        this.path = claudeTranscriptPath(workspaceRoot, sessionId)
    }

    append(message: TAgentMessage): void {
        const entry: IClaudeTranscriptEntry = {
            ...this.entry(message),
            uuid: message.id,
            parentUuid: this.parentUuid,
            sessionId: this.sessionId,
            timestamp: new Date(message.createdAt).toISOString(),
            cwd: this.workspaceRoot,
            isSidechain: false,
            entrypoint: "buli",
        }
        try {
            mkdirSync(dirname(this.path), { recursive: true })
            appendFileSync(this.path, `${JSON.stringify(entry)}\n`)
            this.parentUuid = message.id
        } catch {
            // The transcript feeds learning hooks; losing a line must not stop the conversation.
        }
    }

    private entry(message: TAgentMessage): Pick<IClaudeTranscriptEntry, "type" | "message"> {
        switch (message.role) {
            case "user":
                return { type: "user", message: { role: "user", content: message.content } }
            case "toolResult":
                return {
                    type: "user",
                    message: {
                        role: "user",
                        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content, is_error: message.isError }],
                    },
                }
            case "assistant":
                return {
                    type: "assistant",
                    message: {
                        role: "assistant",
                        model: message.model?.modelId ?? "buli",
                        content: message.content.map((part): TClaudeContentBlock => {
                            if (part.type === "text") return { type: "text", text: part.text }
                            if (part.type === "reasoning") return { type: "thinking", thinking: part.text }
                            const tool = toClaudeToolCall(part, this.workspaceRoot)
                            return { type: "tool_use", id: part.toolCallId, name: tool.name, input: tool.input }
                        }),
                    },
                }
        }
    }
}
