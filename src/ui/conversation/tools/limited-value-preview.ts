export function* singleLineTarget(value: string): Generator<string> {
    for (const character of value) {
        switch (character) {
            case "\r": yield* "\\r"; break
            case "\n": yield* "\\n"; break
            case "\t": yield* "\\t"; break
            default: yield character
        }
    }
}

/** Consumes code points, not graphemes or tokens; escaping happens upstream. */
export function compactText(value: Iterable<string>, maximumCharacters: number): string {
    const characters: string[] = []
    for (const character of value) {
        characters.push(character)
        // One extra code point distinguishes exact fit from overflow. Returning here
        // also closes lazy generators before they visit the undisplayed suffix.
        if (characters.length > maximumCharacters) {
            if (maximumCharacters <= 3) return ".".repeat(Math.max(0, maximumCharacters))
            return `${characters.slice(0, maximumCharacters - 3).join("")}...`
        }
    }
    return characters.join("")
}

/**
 * Preview JSON scalars, arrays and plain records without conversion hooks.
 * Encountered cycles, unsupported values, failed reads and exhausted entry budgets
 * get a fixed diagnostic. Truncated previews need not be valid JSON; arbitrary
 * accessor/proxy code is not sandboxed.
 */
export function compactJson(value: unknown, maximumCharacters: number): string {
    const ancestors = new Set<object>()
    // Omitted undefined/function/symbol fields emit nothing, so output alone does
    // not bound their traversal. This allowance also bounds recursive descent.
    let remainingEntries = maximumCharacters + 1

    function* characters(value: unknown): Generator<string> {
        if (typeof value === "string") {
            // Two UTF-16 units per code point, plus lookahead. If sliced, there is
            // enough text that the artificial closing quote cannot reach the preview.
            // Native quoting preserves control escapes and escapes lone surrogates.
            yield* JSON.stringify(value.slice(0, 2 * (maximumCharacters + 1)))
            return
        }
        if (value === null || typeof value === "boolean" || typeof value === "number") {
            yield* JSON.stringify(value)
            return
        }
        if (typeof value !== "object" || ancestors.has(value)) {
            throw new Error("Tool preview requires acyclic JSON data")
        }
        const array = Array.isArray(value)
        const prototype = Object.getPrototypeOf(value)
        if (!array && prototype !== Object.prototype && prototype !== null) {
            throw new Error("Tool preview requires JSON data objects")
        }
        ancestors.add(value)
        if (array) {
            yield "["
            const length = value.length
            for (let index = 0; index < length; index++) {
                if (remainingEntries-- <= 0) throw new Error("Tool preview entry limit")
                if (index > 0) yield ","
                const item: unknown = value[index]
                yield* characters(
                    item === undefined || typeof item === "function" || typeof item === "symbol"
                        ? null
                        : item,
                )
            }
            yield "]"
        } else {
            yield "{"
            let separator = ""
            // Avoid allocating Object.keys/entries. Engines may still enumerate all
            // keys internally: value reads are bounded, wide-object enumeration is not.
            for (const key in value) {
                if (remainingEntries-- <= 0) throw new Error("Tool preview entry limit")
                if (!Object.hasOwn(value, key)) continue
                const item = (value as Record<string, unknown>)[key]
                if (item === undefined || typeof item === "function" || typeof item === "symbol") {
                    continue
                }
                yield* separator
                yield* characters(key)
                yield ":"
                yield* characters(item)
                separator = ","
            }
            yield "}"
        }
        ancestors.delete(value)
    }

    try {
        return compactText(characters(value), maximumCharacters)
    } catch {
        return "[unserializable]"
    }
}
