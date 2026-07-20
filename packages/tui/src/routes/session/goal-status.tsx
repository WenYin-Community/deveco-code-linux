import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { formatDuration } from "../../util/format"
import { formatGoalStatus, goalElapsedSeconds, goalFromMetadata, goalTokenUsage } from "../../prompt/goal"

export function GoalStatus(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const goal = createMemo(() => goalFromMetadata(sync.session.get(props.sessionID)?.metadata))
  const tokens = createMemo(() => {
    const current = goal()
    if (!current) return 0
    return goalTokenUsage(current, sync.data.message[props.sessionID] ?? [])
  })
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
        <box width="100%" height={1} flexDirection="row" justifyContent="flex-end" paddingRight={1}>
          <text fg={color()} wrapMode="none">
            {formatGoalStatus(current(), tokens(), duration())}
          </text>
        </box>
      )}
    </Show>
  )
}
