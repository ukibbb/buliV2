import { useKeyboard, usePaste } from "@opentui/react"
import { useEffect, useRef, useState } from "react"

import { theme } from "@/ui/terminal/theme"

interface ISecretInputProps {
    readonly placeholder: string
    readonly onSubmit: (value: string) => void
}

export function SecretInput({ placeholder, onSubmit }: ISecretInputProps) {
    const value = useRef("")
    const submitted = useRef(false)
    const [length, setLength] = useState(0)
    useEffect(() => () => { value.current = "" }, [])

    const update = (next: string) => {
        value.current = next
        setLength(Array.from(next).length)
    }
    usePaste((event) => {
        event.preventDefault()
        event.stopPropagation()
        if (submitted.current) return
        const text = new TextDecoder().decode(event.bytes)
        if (/[\u0000-\u001f\u007f]/u.test(text)) return
        update(value.current + text)
    })
    useKeyboard((key) => {
        if (key.name === "escape") {
            update("")
            return
        }
        key.preventDefault()
        key.stopPropagation()
        if (submitted.current || key.eventType === "release") return
        if (key.name === "return" || key.name === "enter") {
            if (!value.current.trim()) return
            const input = value.current
            submitted.current = true
            update("")
            onSubmit(input)
        } else if (key.name === "backspace") {
            update(Array.from(value.current).slice(0, -1).join(""))
        } else if (key.ctrl && key.name === "u") {
            update("")
        } else if (!key.ctrl && !key.meta && !key.option && !key.super && !key.hyper
            && key.sequence && !/[\u0000-\u001f\u007f]/u.test(key.sequence)) {
            update(value.current + key.sequence)
        }
    })

    return <text selectable={false} fg={length ? theme.text : theme.textMuted}>
        {length ? "*".repeat(Math.min(length, 64)) : placeholder}
    </text>
}
