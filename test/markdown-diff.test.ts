import { expect, test } from "bun:test"

import { normalizeMarkdownDiff } from "@/sessions/ui/markdown-diff"

test("repairs inaccurate hunk counts without changing the source diff", () => {
    const diff = [
        "--- a/src/agent/system-prompt.ts",
        "+++ b/src/agent/system-prompt.ts",
        "@@ -300,8 +300,12 @@ const CODE_EXPLANATION_INSTRUCTIONS = [",
        " context one",
        " context two",
        " context three",
        " context four",
        "+added one",
        "+added two",
        "+added three",
        "+added four",
        " context five",
        " context six",
        " context seven",
    ].join("\n")

    const normalized = normalizeMarkdownDiff(diff)

    expect(diff).toContain("@@ -300,8 +300,12 @@")
    expect(normalized).toBe(diff.replace(
        "@@ -300,8 +300,12 @@",
        "@@ -300,7 +300,11 @@",
    ))
})

test("repairs an off-by-one added count from an assistant response", () => {
    const diff = [
        "--- a/src/agent/agent-loop.ts",
        "+++ b/src/agent/agent-loop.ts",
        "@@ -41,6 +41,17 @@ export interface IAgentApprovalContext {",
        "     readonly signal: AbortSignal",
        " }",
        " ",
        "+/**",
        "+ * Bridges a tool's approval request to Agent state and the UI.",
        "+ *",
        "+ * No production tool currently uses this bridge; the end-to-end infrastructure",
        "+ * is implemented and covered by tests. To enable approval for a tool:",
        "+ * 1. Set its `approvalKind` to a kind declared in `tool-approval.ts`.",
        "+ * 2. Call and await `context.requestApproval(draft)` inside `tool.execute()`.",
        "+ * 3. Handle every returned decision before performing the protected action.",
        "+ * 4. Present `tool_approval_requested` in the UI and pass the user's decision",
        "+ *    through `BuliRuntime.resolveToolApproval()`.",
        "+ * 5. Add focused tool, Agent, session, runtime, and UI tests for the full flow.",
        "+ */",
        " export type TAgentApprovalHandler = (",
        "     draft: TToolApprovalDraft,",
        "     context: IAgentApprovalContext,",
    ].join("\n")

    expect(normalizeMarkdownDiff(diff)).toContain(
        "@@ -41,6 +41,18 @@",
    )
})

test("keeps a valid diff exact", () => {
    const diff = [
        "--- a/first.ts",
        "+++ b/first.ts",
        "@@ -1 +1 @@",
        "-const first = 1",
        "+const first = 2",
    ].join("\n")

    expect(normalizeMarkdownDiff(diff)).toBe(diff)
})

test("rejects structurally malformed diff content", () => {
    const malformed = [
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1 +1 @@",
        "line without a diff prefix",
    ].join("\n")

    expect(normalizeMarkdownDiff(malformed)).toBeUndefined()
})
