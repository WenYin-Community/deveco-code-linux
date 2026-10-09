import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  // Tokens freed by History Snip Compact since the last completed assistant
  // message. The Context panel shows the last assistant usage snapshot; snip
  // replaces old tool results without rewriting that snapshot, so apply the
  // freed tokens as an offset and drop it once a newer assistant snapshot
  // (whose usage already reflects the snipped context) arrives.
  const [snipFreed, setSnipFreed] = createSignal(0)

  onMount(() => {
    const offSnipped = props.api.event.on("session.snipped", (e) => {
      if (e.properties.sessionID !== props.session_id) return
      const freed = Number(e.properties.tokensFreed)
      if (!Number.isFinite(freed)) return
      setSnipFreed((prev) => prev + freed)
    })
    const offUpdated = props.api.event.on("message.updated", (e) => {
      if (e.properties.sessionID !== props.session_id) return
      const info = e.properties.info
      if (info.role !== "assistant" || info.tokens.output <= 0) return
      setSnipFreed(0)
    })
    onCleanup(() => {
      offSnipped()
      offUpdated()
    })
  })

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const raw =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const tokens = Math.max(0, raw - snipFreed())
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
