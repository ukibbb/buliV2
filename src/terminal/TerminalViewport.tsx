import type { ReactNode } from "react"

interface TerminalViewportProps {
  width: number
  height: number
  children: ReactNode
}

/** Constrains application content to the current terminal viewport. */
export function TerminalViewport(props: TerminalViewportProps): ReactNode {
  return (
    // I can add backgroundColor in future
    <box width={props.width} height={props.height} flexDirection="column">
      {
        /* minHeight - must be at least this tall.
         * it can grow taller
         * if content needs more space
         * flexGrow - ability to flex item to grow if necessery
         * what amount of available space inside
         * flex container if all items are 1 they will be distribiuted equally
         *
         */
      }
      <box minHeight={0} flexGrow={1} flexDirection="column">
        {props.children}
      </box>
    </box>
  )
}
