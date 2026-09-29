import { theme } from "@/ui/terminal/theme"

/** Shared presentation for transcript errors and errors that have no durable message. */
export function ErrorNotice(props: { readonly message: string }) {
    return <box width="100%" flexShrink={0} border borderStyle="single" borderColor={theme.red} paddingX={1}>
        <text fg={theme.red} minWidth={0} flexShrink={1} wrapMode="word">{props.message}</text>
    </box>
}
