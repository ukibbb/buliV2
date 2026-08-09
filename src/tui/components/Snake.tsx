import { useEffect, useState, type ReactNode } from "react"

import { glyphs, theme } from "@/tui/theme";

const SNAKE_TRACK_LENGTH = 8;

const useSnakeAnimationTick = (): number => {

  const [tick, setTick] = useState<number>(0)

  // runs once when `useSnakeAnimationTick` runs
  useEffect(() => {
    // runs every 150ms, returns idetifier for cleanup
    const id = setInterval(() => {
      // every 150ms add one to previous number
      setTick((prev: number) => prev + 1)
    }, 150)
    return () => clearInterval(id)

  }, [])
  return tick
}



export function SnakeAnimation(): ReactNode {
  console.count("SnakeAnimation")
  // add 1 from 0 every 150ms
  const tick = useSnakeAnimationTick()
  // modulo ( % ) is usefull for
  // check if  number is even 2 % 2 == 0
  // check if is divisiable by number number % 5 == 0 - is divisible by 5
  // for repetition. if you want to iterate over same array few times.
  //
  // The expression i % 3 continually produces: 0, 1, 2, 0, 1, 2, ...

  // 17 % 5 | 17 ÷ 5 = 3 | 17 - ( 3 * 5 ) == 2

  // frame 0 → (0 + 2) % 8 = 2
  // frame 1 → (1 + 2) % 8 = 3
  //
  // frame 6 -> ( 6 + 2 ) % 8 = 0
  // frame 7 -> ( 7 + 2 ) % 8 = 1
  //
  // frame 15 -> ( 15 + 2 ) % 8 = 1
  //
  // frame 20 ->  ( 20 + 2 ) % 8  = 6
  const snakeHead = (tick + 2) % SNAKE_TRACK_LENGTH
  // APPLE_POSITION prevents negative numbers

  const snake = new Set([
    (snakeHead + SNAKE_TRACK_LENGTH - 1) % SNAKE_TRACK_LENGTH, // snake body
    (snakeHead + SNAKE_TRACK_LENGTH - 2) % SNAKE_TRACK_LENGTH  // snake ass
  ])

  //   frame % 4              0  1  2  3  0  1  2  3
  // 3 - (frame % 4)          3  2  1  0  3  2  1  0
  const space = (3 - tick % 4)
  const applePosition = (snakeHead + space + SNAKE_TRACK_LENGTH) % SNAKE_TRACK_LENGTH
  return (
    <box flexDirection="row">
      {
        Array.from({ length: SNAKE_TRACK_LENGTH }).map((_, idx) => {
          if (idx === snakeHead) return <text key={idx} fg={theme.amber}>{glyphs.snakeHead}</text>
          if (idx == applePosition) return <text key={idx} fg={theme.red}>{glyphs.apple}</text>
          if (snake.has(idx)) return <text key={idx} fg={theme.pink}>{glyphs.snakeBody}</text>
          return <text key={idx} fg={theme.green}>{glyphs.snakeEmptyTrack}</text>

        })}
    </box>
  )



}
