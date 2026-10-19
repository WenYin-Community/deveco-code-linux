import { createEffect, createResource, on, onCleanup, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { useServerSDK } from "@/context/server-sdk"

/** Product consent belongs to the selected backend, independently of its providers. */
export function ProductAgreementGate(props: ParentProps) {
  const consent = createAgreementConsent()
  return (
    <Show when={consent.accepted()} fallback={<AgreementSetup consent={consent} />}>
      <Show when={consent.agreement()?.upload.state === "review_required"}>
        <AgreementReview consent={consent} />
      </Show>
      {props.children}
    </Show>
  )
}

function createAgreementConsent() {
  const sdk = useServerSDK()
  const [state, setState] = createStore({ checked: false, saving: false, error: "" })
  const [agreement, { refetch }] = createResource(sdk, async (server) => {
    setState({ checked: false, error: "" })
    const result = await server.client.global.productAgreement()
    if (result.error || !result.data?.upload) throw new Error("Unable to load product agreements")
    return result.data
  })
  const refresh = () => Promise.resolve(refetch()).catch(() => {})
  createEffect(() => {
    const unsubscribe = sdk().event.on("global", (event) => {
      if (event.type === "global.disposed" || event.type === "server.connected") void refresh()
    })
    onCleanup(unsubscribe)
  })
  createEffect(
    on(
      () => (agreement.error ? undefined : agreement()?.upload.revision),
      () => setState("checked", false),
    ),
  )
  return {
    sdk,
    state,
    setState,
    agreement,
    refetch,
    refresh,
    accepted: () => !agreement.error && agreement()?.accepted,
    blocked: () => agreement.loading || !state.checked || state.saving,
  }
}

type AgreementConsent = ReturnType<typeof createAgreementConsent>

async function acceptAgreement(consent: AgreementConsent) {
  const current = consent.agreement()
  if (!current || consent.blocked()) return
  consent.setState({ saving: true, error: "" })
  try {
    await consent
      .sdk()
      .client.global.acceptProductAgreement(
        { version: current.version, accepted: true, serviceRevision: current.upload.revision },
        { throwOnError: true },
      )
    await consent.refetch()
  } catch {
    consent.setState("error", "Unable to save your acceptance. Please try again.")
    await consent.refresh()
  } finally {
    consent.setState("saving", false)
  }
}

function AgreementSetup(props: { consent: AgreementConsent }) {
  return (
    <div class="flex size-full items-center justify-center p-6">
      <div class="flex max-w-lg flex-col gap-4 text-text-strong">
        <h1>DevEco Code product agreements</h1>
        <Show when={props.consent.agreement.error} fallback={<AgreementForm consent={props.consent} />}>
          <p role="alert">
            Unable to load product agreements. Check the connection and ensure the server supports product agreements.
          </p>
          <Button onClick={() => void props.consent.refresh()}>Retry</Button>
        </Show>
      </div>
    </div>
  )
}

function AgreementForm(props: { consent: AgreementConsent }) {
  return (
    <Show when={props.consent.agreement()} fallback={<p>Loading product agreements...</p>}>
      {(current) => (
        <>
          <a href={current().termsUrl} target="_blank" rel="noopener noreferrer">
            Terms of Use
          </a>
          <a href={current().privacyUrl} target="_blank" rel="noopener noreferrer">
            Privacy Notice
          </a>
          <AgreementCheckbox consent={props.consent} class="flex items-center gap-2">
            I have read and agree to these product agreements
          </AgreementCheckbox>
          <AgreementError consent={props.consent} />
          <Button disabled={props.consent.blocked()} onClick={() => void acceptAgreement(props.consent)}>
            {props.consent.state.saving ? "Saving..." : "Continue"}
          </Button>
        </>
      )}
    </Show>
  )
}

function AgreementReview(props: { consent: AgreementConsent }) {
  return (
    <section class="flex flex-wrap items-center gap-3 border-b p-3" aria-label="Agreement status">
      <a href={props.consent.agreement()?.termsUrl} target="_blank" rel="noopener noreferrer">
        Updated Terms of Use
      </a>
      <a href={props.consent.agreement()?.privacyUrl} target="_blank" rel="noopener noreferrer">
        Privacy Notice
      </a>
      <AgreementCheckbox consent={props.consent}>I have read and agree to the updated agreements</AgreementCheckbox>
      <Button
        disabled={!props.consent.state.checked || props.consent.state.saving}
        onClick={() => void acceptAgreement(props.consent)}
      >
        Accept updated agreements
      </Button>
      <AgreementError consent={props.consent} />
    </section>
  )
}

function AgreementCheckbox(props: ParentProps<{ consent: AgreementConsent; class?: string }>) {
  return (
    <label class={props.class}>
      <input
        type="checkbox"
        checked={props.consent.state.checked}
        onChange={(event) => props.consent.setState("checked", event.currentTarget.checked)}
      />
      {props.children}
    </label>
  )
}

function AgreementError(props: { consent: AgreementConsent }) {
  return (
    <Show when={props.consent.state.error}>
      <p role="alert">{props.consent.state.error}</p>
    </Show>
  )
}
