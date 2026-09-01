import type { ReactNode } from "react"

import type { IFileChangeProposal } from "@/agent"
import { syntax, theme } from "@/terminal/theme"

interface IProposedChangesProps {
    readonly proposal: IFileChangeProposal
}

/** Displays the exact generated diff inside the conversation transcript. */
export function ProposedChanges(
    props: IProposedChangesProps,
): ReactNode {
    return <diff
        diff={props.proposal.diff}
        width="100%"
        view="unified"
        fg={theme.text}
        syntaxStyle={syntax}
        wrapMode="word"
        showLineNumbers
    />
}
