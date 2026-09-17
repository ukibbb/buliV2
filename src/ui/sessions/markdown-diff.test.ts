import { expect, test } from "bun:test"

import { normalizeMarkdownDiff } from "@/ui/sessions/markdown-diff"

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
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -41,6 +41,17 @@ export interface ITaskContext {",
        "     readonly signal: AbortSignal",
        " }",
        " ",
        "+/**",
        "+ * Executes a task using its caller's cancellation context.",
        "+ *",
        "+ * The handler owns execution while the caller owns cancellation.",
        "+ * Implementations follow these rules:",
        "+ * 1. Validate the task before starting work.",
        "+ * 2. Check the signal before performing an operation.",
        "+ * 3. Await every asynchronous operation.",
        "+ * 4. Release temporary resources when execution finishes",
        "+ *    or cancellation interrupts the task.",
        "+ * 5. Test successful execution, failures, and cancellation.",
        "+ */",
        " export type TTaskHandler = (",
        "     task: ITask,",
        "     context: ITaskContext,",
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
