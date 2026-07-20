import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { createSignal, onMount, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useDialog, type DialogContext } from "../../ui/dialog"
import { useBindings } from "../../keymap"
import { formatGoalTokenCount, parseGoalBudget } from "../../prompt/goal"

type Props = {
  current: number | null
  onSave: (value: number | null) => void
  onCancel: () => void
}

function DialogGoalBudgetView(props: Props) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [target, setTarget] = createSignal<TextareaRenderable>()
  const [error, setError] = createSignal<string>()
  let input: TextareaRenderable

  function save() {
    const result = parseGoalBudget(input.plainText)
    if (!result.valid) {
      setError(result.message)
      return
    }
    props.onSave(result.value)
    dialog.clear()
  }

  useBindings(() => ({
    target,
    priority: 1,
    bindings: [
      {
        key: "return",
        desc: "Save Goal budget",
        group: "Dialog",
        cmd: save,
      },
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => input.focus(), 1)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Goal Budget
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>
        Current: {props.current === null ? "Unlimited" : `${formatGoalTokenCount(props.current)} tokens`}
      </text>
      <textarea
        height={1}
        ref={(value: TextareaRenderable) => {
          input = value
          setTarget(value)
        }}
        placeholder="Budget"
        placeholderColor={theme.textMuted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.text}
      />
      <text fg={theme.textMuted}>Examples: 10000, 100k, 100K, 1.5m, 1.5M</text>
      <Show when={error()}>{(message) => <text fg={theme.error}>{message()}</text>}</Show>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <box
          paddingLeft={1}
          paddingRight={1}
          onMouseUp={() => {
            props.onCancel()
            dialog.clear()
          }}
        >
          <text fg={theme.textMuted}>Cancel</text>
        </box>
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme.primary} onMouseUp={save}>
          <text fg={theme.selectedListItemText}>Save</text>
        </box>
      </box>
    </box>
  )
}

export namespace DialogGoalBudget {
  export async function show(dialog: DialogContext, current: number | null): Promise<number | null | undefined> {
    return new Promise((resolve) => {
      dialog.replace(
        () => (
          <DialogGoalBudgetView
            current={current}
            onSave={(value) => resolve(value)}
            onCancel={() => resolve(undefined)}
          />
        ),
        () => resolve(undefined),
      )
    })
  }
}
