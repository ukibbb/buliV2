import { expect, test } from "bun:test"

import { abortMessage } from "@/agent/abort"

test("uses the original error message, including an empty message", () => {
    for (const message of ["Cancelled by user", ""]) {
        expect(abortMessage(AbortSignal.abort(new Error(message)))).toBe(message)
    }
})

test("preserves string cancellation reasons, including an empty string", () => {
    for (const reason of ["Cancelled by user", ""]) {
        expect(abortMessage(AbortSignal.abort(reason))).toBe(reason)
    }
})

test("uses the agent fallback for non-error, non-string reasons", () => {
    for (const reason of [null, 42, false, { cancelled: true }]) {
        expect(abortMessage(AbortSignal.abort(reason))).toBe("Buli interaction was aborted")
    }
    expect(abortMessage(new AbortController().signal)).toBe("Buli interaction was aborted")
})

test("uses the platform error message when aborted without an explicit reason", () => {
    const signal = AbortSignal.abort()
    expect(abortMessage(signal)).toBe(signal.reason.message)
})
