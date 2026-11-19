/** @jsxImportSource @opentui/solid */
import { createRenderEffect, onCleanup } from "solid-js"
import { useDialog } from "../../src/ui/dialog"

export function CrashDialog() {
  return (
    <box width={44} height={8}>
      <text>CRASH_DIALOG</text>
    </box>
  )
}

export function StartupHomeBody(props: { sync: { status: string }; blocking: () => boolean }) {
  const dialog = useDialog()
  createRenderEffect(() => {
    if (props.blocking()) onCleanup(dialog.blockAutomatic())
  })
  return (
    <box width={40} height={4}>
      <text>{props.sync.status === "complete" ? "SYNC_DONE" : "SYNC_LOADING"}</text>
    </box>
  )
}
