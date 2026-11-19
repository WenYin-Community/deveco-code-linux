import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createAnnouncementService, type AnnouncementState } from "../announcements/service"
import { createSimpleContext } from "./helper"
import { useTuiPaths } from "./runtime"

export const { use: useAnnouncements, provider: AnnouncementsProvider } = createSimpleContext({
  name: "Announcements",
  init: () => {
    const paths = useTuiPaths()
    const emptyState: AnnouncementState = {
      items: [],
      promptVersion: 0,
    }
    const [state, setState] = createSignal(emptyState)
    const [agreementAccepted, setAgreementAccepted] = createSignal(false)
    let service: ReturnType<typeof createAnnouncementService> | undefined
    const items = createMemo(() => state().items)
    const unread = createMemo(() => items().filter((item) => !item.read).length)

    createEffect(() => {
      if (!agreementAccepted()) {
        setState(emptyState)
        return
      }
      const active = createAnnouncementService({ stateDir: paths.state, onChange: setState })
      service = active
      onCleanup(() => {
        active.stop()
        service = undefined
      })
      void active.start().catch(() => undefined).then(() => active.refresh())
    })

    return {
      agreementAccepted,
      setAgreement(agreement?: { accepted: boolean; upload?: { state: string } }) {
        const status = agreement?.upload?.state
        setAgreementAccepted(
          agreement?.accepted === true && (status === "local" || status === "pending" || status === "uploaded"),
        )
      },
      items,
      unread,
      get promptVersion() {
        return state().promptVersion
      },
      ackPrompt: (version: number) => service?.ackPrompt(version),
      markRead: async (key: string) => service?.markRead(key),
    }
  },
})
