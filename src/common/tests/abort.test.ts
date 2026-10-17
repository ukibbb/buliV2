import { expect, test } from "bun:test"

import { abortReasonError } from "@/common/abort"

test("preserves the original error object and its details", () => {
    const reason = new TypeError("Original reason", { cause: new Error("Cause") })
    expect(abortReasonError(AbortSignal.abort(reason), "Fallback")).toBe(reason)
})

test("creates an AbortError with the supplied fallback for non-error reasons", () => {
    for (const reason of ["User cancelled", "", null, 42, false, { cancelled: true }]) {
        const error = abortReasonError(AbortSignal.abort(reason), "Operation was cancelled")
        expect(error).toBeInstanceOf(Error)
        expect(error.name).toBe("AbortError")
        expect(error.message).toBe("Operation was cancelled")
    }
})

test("uses each caller's fallback message", () => {
    for (const message of [
        "OpenAI OAuth operation was cancelled",
        "OpenAI OAuth login was cancelled",
        "OpenAI authentication was cancelled",
    ]) {
        expect(abortReasonError(AbortSignal.abort(null), message).message).toBe(message)
    }
})

test("preserves the platform error when aborted without an explicit reason", () => {
    const signal = AbortSignal.abort()
    expect(abortReasonError(signal, "Fallback")).toBe(signal.reason)
})

test("creates a fallback error for a signal that has not been aborted", () => {
    const error = abortReasonError(new AbortController().signal, "Fallback")
    expect(error.name).toBe("AbortError")
    expect(error.message).toBe("Fallback")
})
