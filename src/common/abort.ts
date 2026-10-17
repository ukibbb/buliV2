/** Preserves an existing error or creates a cancellation error with the fallback message. */
export function abortReasonError(
    signal: AbortSignal,
    fallbackMessage: string,
): Error {
    if (signal.reason instanceof Error) return signal.reason

    const error = new Error(fallbackMessage)
    error.name = "AbortError"
    return error
}
