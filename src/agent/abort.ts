/** Formats cancellation reasons for agent messages. */
export function abortMessage(signal: AbortSignal): string {
    if (signal.reason instanceof Error) return signal.reason.message
    return typeof signal.reason === "string"
        ? signal.reason
        : "Buli interaction was aborted"
}
