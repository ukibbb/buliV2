import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { type ReactNode } from "react"

import { useSession } from "@/application-state";
import { Chat } from "@/tui/components/Chat";
import { Layout } from "@/tui/components/Layout";
import { Transcript } from "@/tui/components/Transcript";
import type { KeyEvent } from "@opentui/core";
import type { ISessionSnapshot } from "@/engine/session-view-store"



interface SessionProps {
  sessionId: string
}



function Session({ sessionId }: SessionProps): ReactNode {
  console.count("Session")
  const session: ISessionSnapshot = useSession(sessionId)

  return (
    <box
      width="100%"
      height="100%"
      minHeight={0}
      flexDirection="column"
    >
      <scrollbox
        width="100%"
        minHeight={0}
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
      >
        <Transcript messages={session.messages} />
      </scrollbox>

      <Chat sessionId={sessionId} />
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
