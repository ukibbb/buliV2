import { theme } from "@/ui/terminal/theme"

interface IMessageCardProps {
    readonly id: string
    readonly content: string
    readonly borderColor: string
    readonly title?: string
    readonly marginY?: number
}

export function MessageCard(props: IMessageCardProps) {
    return <box
        id={props.id}
        width="100%"
        flexShrink={0}
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={props.borderColor}
        {...(props.title === undefined ? {} : { title: props.title })}
        titleColor={props.borderColor}
        marginY={props.marginY ?? 0}
        paddingX={1}
        buffered
        renderAfter={function (buffer) {
            // OpenTUI 0.5.12 draws box borders outside the scroll scissor and uses
            // screen coordinates even in a local buffer. Composite a local border.
            buffer.clear()
            buffer.drawBox({
                x: 0,
                y: 0,
                width: this.width,
                height: this.height,
                border: true,
                borderStyle: "single",
                borderColor: this.borderColor,
                backgroundColor: this.backgroundColor,
                ...(props.title === undefined ? {} : { title: props.title }),
                titleColor: this.borderColor,
            })
        }}
    >
        <text fg={theme.text} wrapMode="word" truncate={false}>
            {props.content}
        </text>
    </box>
}
