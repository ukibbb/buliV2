import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useState } from "react"

import { SnakeAnimation } from "./components/Snake";
import { Chat } from "./components/Chat";
import type { KeyEvent } from "@opentui/core";

export function Buli() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions()

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "d") {
      renderer.console.toggle();
    }
  });

  console.count("buli")
  return (
    <box style={{
      width: width,
      height: height,
      flexDirection: "column"
    }}>
      <Chat />
    </box>
  )
}
