interface IAnsiStyle {
    fg?: string
    bg?: string
    bold?: boolean
    dim?: boolean
}

/** One run of text with the colors and weight its SGR escape codes selected. */
export type IAnsiSpan = Readonly<IAnsiStyle> & { readonly text: string }

// xterm's default palette for SGR 30-37/90-97 and the first 16 entries of 38;5.
const BASIC_COLORS = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
] as const

// CSI sequences (SGR ends in "m"), OSC sequences such as hyperlinks, and other two-byte escapes.
const ESCAPE = /\x1b\[([0-9;]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** Splits terminal output into lines of styled spans; non-SGR escapes are dropped. */
export function parseAnsiLines(output: string): IAnsiSpan[][] {
    const lines: IAnsiSpan[][] = []
    // SGR state carries across lines, as in a terminal.
    let style: IAnsiStyle = {}
    for (const text of output.replaceAll("\r", "").split("\n")) {
        const line: IAnsiSpan[] = []
        let position = 0
        for (const match of text.matchAll(ESCAPE)) {
            if (match.index > position) line.push({ text: text.slice(position, match.index), ...style })
            position = match.index + match[0].length
            if (match[2] === "m") style = applySgr(style, match[1] ?? "")
        }
        if (position < text.length) line.push({ text: text.slice(position), ...style })
        lines.push(line)
    }
    while (lines.length > 0 && lines.at(-1)!.length === 0) lines.pop()
    return lines
}

function applySgr(current: IAnsiStyle, parameters: string): IAnsiStyle {
    const codes = parameters === "" ? [0] : parameters.split(";").map(Number)
    let style = { ...current }
    for (let index = 0; index < codes.length; index += 1) {
        const code = codes[index]!
        if (code === 0) style = {}
        else if (code === 1) style.bold = true
        else if (code === 2) style.dim = true
        else if (code === 22) { delete style.bold; delete style.dim }
        else if (code === 39) delete style.fg
        else if (code === 49) delete style.bg
        else if (code >= 30 && code <= 37) style.fg = basicColor(code - 30)
        else if (code >= 90 && code <= 97) style.fg = basicColor(code - 82)
        else if (code >= 40 && code <= 47) style.bg = basicColor(code - 40)
        else if (code >= 100 && code <= 107) style.bg = basicColor(code - 92)
        else if (code === 38 || code === 48) {
            const extended = extendedColor(codes, index + 1)
            if (extended.color) style[code === 38 ? "fg" : "bg"] = extended.color
            index = extended.lastIndex
        }
    }
    return style
}

/** Reads `2;r;g;b` or `5;n` after 38/48; returns the index of the last code consumed. */
function extendedColor(codes: readonly number[], start: number): { color?: string; lastIndex: number } {
    if (codes[start] === 2) {
        const [red, green, blue] = codes.slice(start + 1, start + 4)
        if (blue === undefined) return { lastIndex: codes.length }
        return { color: hex(red!, green!, blue), lastIndex: start + 3 }
    }
    if (codes[start] === 5 && codes[start + 1] !== undefined) {
        return { color: paletteColor(codes[start + 1]!), lastIndex: start + 1 }
    }
    return { lastIndex: start }
}

/** xterm 256-color palette: 16 basic colors, a 6x6x6 cube, then 24 grays. */
function paletteColor(index: number): string {
    if (index < 16) return basicColor(index)
    if (index < 232) {
        const level = (value: number) => (value === 0 ? 0 : 55 + value * 40)
        const cube = index - 16
        return hex(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6))
    }
    const gray = 8 + (Math.min(index, 255) - 232) * 10
    return hex(gray, gray, gray)
}

function basicColor(index: number): string {
    return BASIC_COLORS[index] ?? BASIC_COLORS[7]
}

function hex(red: number, green: number, blue: number): string {
    return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`
}
