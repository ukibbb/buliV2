const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Matches OpenTUI prompt offsets: grapheme cell widths plus one cell per newline/tab. */
export function displayTextWidth(value: string): number {
    let width = 0
    for (const part of graphemes.segment(value)) {
        width += part.segment === "\n" || part.segment === "\t"
            ? 1
            : Bun.stringWidth(part.segment)
    }
    return width
}

/** Slices text using terminal display offsets rather than UTF-16 indexes. */
export function displayTextSlice(
    value: string,
    start: number,
    end: number,
): string {
    return value.slice(
        displayOffsetIndex(value, start),
        displayOffsetIndex(value, end),
    )
}

function displayOffsetIndex(value: string, offset: number): number {
    if (offset <= 0) return 0
    let width = 0
    for (const part of graphemes.segment(value)) {
        if (width >= offset) return part.index
        const partWidth = part.segment === "\n" || part.segment === "\t"
            ? 1
            : Bun.stringWidth(part.segment)
        if (width + partWidth > offset) return part.index
        width += partWidth
    }
    return value.length
}
