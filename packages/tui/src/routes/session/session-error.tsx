import type { BoxRenderable } from "@opentui/core"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { turnRecoveryFailure } from "@opencode-ai/ui/session-error-message"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useI18n } from "../../i18n"
import { SplitBorder } from "../../ui/border"

export function SessionError(props: { error: AssistantMessage["error"]; onCreate: (element: BoxRenderable) => void }) {
  const theme = useTheme().theme
  const i18n = useI18n()
  const text = createMemo(() => {
    const failure = turnRecoveryFailure(props.error)
    if (!failure) return props.error?.data.message
    const suffix = failure.retried ? "_after_recovery" : ""
    return i18n.t(`session.error_${failure.cause}${suffix}`)
  })
  return (
    <Show when={props.error && props.error.name !== "MessageAbortedError"}>
      <box
        ref={props.onCreate}
        border={["left"]}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        marginTop={1}
        backgroundColor={theme.backgroundPanel}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.error}
      >
        <text fg={theme.textMuted}>{text()}</text>
      </box>
    </Show>
  )
}
