import { Show, type ParentProps } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { useI18n } from "../i18n"
import { Spinner } from "./spinner"

export function DialogProviderProgress(props: ParentProps<{ title: string; status: string; description?: string }>) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const { t } = useI18n()
  return (
    <box paddingLeft={4} paddingRight={2} paddingBottom={1} gap={1} width="100%" flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {t("dialog.esc")}
        </text>
      </box>
      <Spinner color={theme.primary}>
        <span style={{ fg: theme.text }}>{props.status}</span>
      </Spinner>
      <Show when={props.description}>
        <text fg={theme.textMuted}>{props.description}</text>
      </Show>
      {props.children}
    </box>
  )
}
