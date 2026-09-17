import {
    addDefaultParsers,
    type FiletypeParserOptions,
} from "@opentui/core"

// Static file imports are required to embed parser assets in Bun executables.
import bashHighlights from "./assets/tree-sitter/bash-highlights.scm" with { type: "file" }
import bashWasm from "./assets/tree-sitter/tree-sitter-bash.wasm" with { type: "file" }
import pythonHighlights from "./assets/tree-sitter/python-highlights.scm" with { type: "file" }
import pythonWasm from "./assets/tree-sitter/tree-sitter-python.wasm" with { type: "file" }

export const terminalParserOptions = [
    {
        filetype: "python",
        aliases: ["py", "pyi"],
        wasm: pythonWasm,
        queries: {
            highlights: [pythonHighlights],
        },
    },
    {
        filetype: "bash",
        aliases: ["sh", "zsh", "ksh", "shell"],
        wasm: bashWasm,
        queries: {
            highlights: [bashHighlights],
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
