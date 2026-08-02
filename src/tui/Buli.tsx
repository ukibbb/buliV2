import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { type ReactNode } from "react"

import { useSession } from "@/application-state";
import { Chat } from "@/tui/components/Chat";
import { Layout } from "@/tui/components/Layout";
import type { KeyEvent } from "@opentui/core";



interface SessionProps {
  sessionId: string
}


function Transcript(): ReactNode {
  console.count("Transcript")
  // TODO: Accept the selected session snapshot and render its messages.
  return
}

function Session({ sessionId }: SessionProps): ReactNode {
  console.count("Session")

  const session = useSession(sessionId)

  return (
    <box>
      <box>
        <scrollbox>
          <Transcript />
        </scrollbox>
        <box>
          <Chat sessionId={sessionId} />
        </box>
      </box>
    </box>
  )
}


export function BuliTui() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions()

  // render welcome screen if not session
  // else choose session



  // useKeyboard
  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "d") {
      renderer.console.toggle();
    }
  });

  console.count("buli")
  return (
    <Layout width={width} height={height}>
      <Session sessionId={"default"} />
    </Layout>
  )
}
