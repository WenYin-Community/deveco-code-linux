import { createEffect, createResource, on, onCleanup, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { useServerSDK } from "@/context/server-sdk"

/** Product consent belongs to the selected backend, independently of its providers. */
export function ProductAgreementGate(props: ParentProps) {
  const sdk = useServerSDK()
  const [state, setState] = createStore({
    checked: false,
    saving: false,
    error: "",
  })
  const [agreement, { refetch }] = createResource(sdk, async (server) => {
    setState({ checked: false, error: "" })
    const result = await server.client.global.productAgreement()
    if (result.error || !result.data?.upload) throw new Error("Unable to load product agreements")
    return result.data
  })

  createEffect(() => {
    const unsubscribe = sdk().event.on("global", (event) => {
      if (event.type === "global.disposed" || event.type === "server.connected")
        void Promise.resolve(refetch()).catch(() => {})
    })
    onCleanup(unsubscribe)
  })

  createEffect(
    on(
      () => (agreement.error ? undefined : agreement()?.upload.revision),
      () => setState("checked", false),
    ),
  )

  const accept = async () => {
    const current = agreement()
    if (!current || agreement.loading || !state.checked || state.saving) return
    setState({ saving: true, error: "" })
    try {
      await sdk().client.global.acceptProductAgreement(
        { version: current.version, accepted: true, serviceRevision: current.upload.revision },
        { throwOnError: true },
      )
      await refetch()
    } catch {
      setState("error", "Unable to save your acceptance. Please try again.")
      await Promise.resolve(refetch()).catch(() => {})
    } finally {
      setState("saving", false)
    }
  }

  return (
    <Show
      when={!agreement.error && agreement()?.accepted}
      fallback={
        <div class="flex size-full items-center justify-center p-6">
          <div class="flex max-w-lg flex-col gap-4 text-text-strong">
            <h1>DevEco Code product agreements</h1>
            <Show
              when={agreement.error}
              fallback={
                <Show when={agreement()} fallback={<p>Loading product agreements...</p>}>
                  {(current) => (
                    <>
                      <a href={current().termsUrl} target="_blank" rel="noopener noreferrer">
                        Terms of Use
                      </a>
                      <a href={current().privacyUrl} target="_blank" rel="noopener noreferrer">
                        Privacy Notice
                      </a>
                      <label class="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={state.checked}
                          onChange={(event) => setState("checked", event.currentTarget.checked)}
                        />
                        I have read and agree to these product agreements
                      </label>
                      <Show when={state.error}>
                        <p role="alert">{state.error}</p>
                      </Show>
                      <Button
                        disabled={agreement.loading || !state.checked || state.saving}
                        onClick={() => void accept()}
                      >
                        {state.saving ? "Saving..." : "Continue"}
                      </Button>
                    </>
                  )}
                </Show>
              }
            >
              <p role="alert">
                Unable to load product agreements. Check the connection and ensure the server supports product
                agreements.
              </p>
              <Button onClick={() => void Promise.resolve(refetch()).catch(() => {})}>Retry</Button>
            </Show>
          </div>
        </div>
      }
    >
      <Show when={agreement()?.upload.state === "review_required"}>
        <section class="flex flex-wrap items-center gap-3 border-b p-3" aria-label="Agreement status">
          <Show when={agreement()?.upload.state === "review_required"}>
            <a href={agreement()?.termsUrl} target="_blank" rel="noopener noreferrer">
              Updated Terms of Use
            </a>
            <a href={agreement()?.privacyUrl} target="_blank" rel="noopener noreferrer">
              Privacy Notice
            </a>
            <label>
              <input
                type="checkbox"
                checked={state.checked}
                onChange={(event) => setState("checked", event.currentTarget.checked)}
              />{" "}
              I have read and agree to the updated agreements
            </label>
            <Button disabled={!state.checked || state.saving} onClick={() => void accept()}>
              Accept updated agreements
            </Button>
          </Show>
          <Show when={state.error}>
            <p role="alert">{state.error}</p>
          </Show>
        </section>
      </Show>
      {props.children}
    </Show>
  )
}
