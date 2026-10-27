import { TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import { useI18n } from "../i18n"

/**
 * Shown when a session points at a working directory that was deleted on disk.
 * The dialog is purely presentational: the "continue" action is injected by the
 * caller so this component stays renderable without the session contexts. Cancelling
 * closes the dialog, and the dialog's own close callback tells the caller what that
 * means for the session.
 */
export function DialogSessionDirectoryMissing(props: {
  // The instance API reports the directory without a session, so it is optional.
  directory?: string
  // Resolving to false keeps the dialog open, which is how a failed move stays retryable.
  onContinue?: () => boolean | void | Promise<boolean | void>
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const { t } = useI18n()
  const [store, setStore] = createStore({
    active: "continue" as "cancel" | "continue",
  })

  const options = ["cancel", "continue"] as const

  // Guards against a second confirm while the first one is still in flight: the
  // move is an HTTP round trip, and a double Enter would fire it twice.
  let pending = false

  function cancel() {
    dialog.clear()
  }

  async function confirm() {
    // Backing out stays available while the move is in flight: only a second
    // confirm has to be ignored, not the user changing their mind.
    if (store.active === "cancel") {
      cancel()
      return
    }
    if (pending) return
    pending = true
    try {
      const result = await props.onContinue?.()
      // A failed move resolves to false and the dialog stays on screen for a retry;
      // a successful one closes it from inside the callback.
      if (result === false) return
    } finally {
      pending = false
    }
  }

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: t("dialog.keybind_confirm_session_directory_option"),
        group: t("category.dialog"),
        cmd: () => void confirm(),
      },
      {
        key: "left",
        desc: t("dialog.keybind_cancel_session_directory_option"),
        group: t("category.dialog"),
        cmd: () => setStore("active", "cancel"),
      },
      {
        key: "right",
        desc: t("dialog.keybind_continue_session_in_current_directory"),
        group: t("category.dialog"),
        cmd: () => setStore("active", "continue"),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("dialog.title_session_directory_missing")}
        </text>
        <text fg={theme.textMuted} onMouseUp={cancel}>
          {t("dialog.esc")}
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {t("dialog.session_directory_missing_desc")}
      </text>
      <Show when={props.directory}>
        <text fg={theme.text} wrapMode="word">
          {props.directory}
        </text>
      </Show>
      <text fg={theme.textMuted} wrapMode="word">
        {t("dialog.session_directory_missing_prompt")}
      </text>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <For each={options}>
          {(item) => (
            <box
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={item === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                setStore("active", item)
                void confirm()
              }}
            >
              <text fg={item === store.active ? theme.selectedListItemText : theme.textMuted}>
                {item === "cancel" ? t("dialog.session_option_cancel") : t("dialog.session_option_continue")}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
