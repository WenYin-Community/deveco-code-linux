import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { formatDuration } from "../../util/format"
import { formatGoalStatus, goalElapsedSeconds, goalFromMetadata } from "../../prompt/goal"

export function GoalStatus(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const goal = createMemo(() => goalFromMetadata(sync.session.get(props.sessionID)?.metadata))
  const [now, setNow] = createSignal(Date.now())

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const duration = createMemo(() => {
    const current = goal()
    if (!current) return "0s"
    return formatDuration(goalElapsedSeconds(current, now())) || "0s"
  })

  const color = createMemo(() => {
    const current = goal()
    if (current?.status === "active") return theme.success
    return theme.textMuted
  })

  return (
    <Show when={goal()}>
      {(current) => (
        <text fg={color()} wrapMode="none" flexShrink={0}>
          {formatGoalStatus(current(), duration())}
        </text>
      )}
    </Show>
  )
}
