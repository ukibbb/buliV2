import { pathToFiletype } from "@opentui/core"
import { parsePatch } from "diff"
import type { ReactNode } from "react"

import { syntax, theme } from "@/ui/terminal/theme"

interface IFileChangeDiffProps {
    readonly diff: string
    readonly path?: string
}

/** Displays file changes independently of their operation or approval status. */
export function FileChangeDiff(props: IFileChangeDiffProps): ReactNode {
    const path = props.path ?? diffPath(props.diff)
    const filetype = path === undefined ? undefined : pathToFiletype(path)
    return <diff
        diff={props.diff}
        {...(filetype === undefined ? {} : { filetype })}
        width="100%"
        view="unified"
        fg={theme.text}
        syntaxStyle={syntax}
        wrapMode="word"
        showLineNumbers
    />
}

function diffPath(diff: string): string | undefined {
    try {
        const patches = parsePatch(diff)
        if (patches.length !== 1) return undefined
        const patch = patches[0]!
        return patch.newFileName === "/dev/null" ? patch.oldFileName : patch.newFileName
    } catch {
        return undefined
    }
}
