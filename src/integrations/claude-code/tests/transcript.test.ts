import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ClaudeTranscript, claudeTranscriptPath } from "@/integrations/claude-code/transcript"

test("names the file like Claude Code: the workspace path with non-alphanumerics as dashes", () => {
    const home = process.env.HOME
    process.env.HOME = "/home/test"
    try {
        expect(claudeTranscriptPath("/Users/me/Desktop/ai/buli.V2", "s1"))
            .toBe("/home/test/.claude/projects/-Users-me-Desktop-ai-buli-V2/s1.jsonl")
    } finally {
        process.env.HOME = home
    }
})

test("appends committed messages as linked Claude Code entries with Claude tool names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-transcript-"))
    const home = process.env.HOME
    try {
        process.env.HOME = directory
        const transcript = new ClaudeTranscript("s1", "/ws")
        const path = transcript.path
        expect(path).toBe(join(directory, ".claude", "projects", "-ws", "s1.jsonl"))
        const base = { sessionId: "s1", runId: "r1", createdAt: 1_700_000_000_000 }
        transcript.append({ ...base, id: "u1", role: "user", source: "prompt", content: "Fix it" })
        transcript.append({
            ...base, id: "a1", role: "assistant", stopReason: "toolUse",
            model: { providerId: "openai", modelId: "gpt-5" },
            content: [
                { type: "reasoning", text: "Plan" },
                { type: "text", text: "Editing" },
                { type: "toolCall", toolCallId: "c1", toolName: "edit", input: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } },
            ],
        })
        transcript.append({
            ...base, id: "t1", role: "toolResult", assistantMessageId: "a1", toolCallId: "c1", toolName: "edit",
            content: "Edited", isError: false,
        })

        const entries = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        expect(entries.map((entry) => [entry.type, entry.uuid, entry.parentUuid])).toEqual([
            ["user", "u1", null], ["assistant", "a1", "u1"], ["user", "t1", "a1"],
        ])
        expect(entries[0]).toMatchObject({
            sessionId: "s1", cwd: "/ws", entrypoint: "buli", timestamp: "2023-11-14T22:13:20.000Z",
            message: { role: "user", content: "Fix it" },
        })
        expect(entries[1].message).toEqual({
            role: "assistant",
            model: "gpt-5",
            content: [
                { type: "thinking", thinking: "Plan" },
                { type: "text", text: "Editing" },
                { type: "tool_use", id: "c1", name: "MultiEdit", input: { file_path: "/ws/a.ts", edits: [{ old_string: "x", new_string: "y" }] } },
            ],
        })
        expect(entries[2].message.content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "Edited", is_error: false }])
    } finally {
        process.env.HOME = home
        await rm(directory, { recursive: true, force: true })
    }
})
