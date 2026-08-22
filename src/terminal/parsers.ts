import {
    addDefaultParsers,
    type FiletypeParserOptions,
} from "@opentui/core"

export const terminalParserOptions = [
    {
        filetype: "python",
        aliases: ["py", "pyi"],
        wasm: "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.23.6/tree-sitter-python.wasm",
        queries: {
            highlights: [
                "https://raw.githubusercontent.com/tree-sitter/tree-sitter-python/v0.23.6/queries/highlights.scm",
            ],
        },
    },
    {
        filetype: "bash",
        aliases: ["sh", "zsh", "ksh"],
        wasm: "https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.0/tree-sitter-bash.wasm",
        queries: {
            highlights: [
                "https://raw.githubusercontent.com/tree-sitter/tree-sitter-bash/v0.25.0/queries/highlights.scm",
            ],
        },
    },
] satisfies FiletypeParserOptions[]

let registered = false

/** Registers optional parsers before OpenTUI initializes its shared Tree-sitter client. */
export function registerTerminalParsers(): void {
    if (registered) return
    addDefaultParsers(terminalParserOptions)
    registered = true
}
