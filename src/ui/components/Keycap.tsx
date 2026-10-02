import { theme } from "@/ui/terminal/theme"

/** Inline key label shared by terminal shortcut hints. */
export function Keycap(props: { readonly keys: string }) {
    return <span fg={theme.violet}>{`[ ${props.keys} ]`}</span>
}
