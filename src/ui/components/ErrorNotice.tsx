import { useId } from "react"
import { MessageCard } from "@/ui/components/MessageCard"
import { theme } from "@/ui/terminal/theme"

/** Errors share user-card wrapping and clipped border rendering. */
export function ErrorNotice(props: { readonly id?: string; readonly message: string }) {
    const fallbackId = useId()
    return <MessageCard
        id={props.id ?? `error-${fallbackId}`}
        content={props.message}
        title="Error"
        borderColor={theme.red}
    />
}
