import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useEditorContext } from "../context/editor"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useI18n } from "../i18n"
import { errorMessage, missingDirectoryError } from "../util/error"
import { DialogSessionDirectoryMissing } from "./dialog-session-directory-missing"

/** Contexts the recovery flow needs; gathered once so the steps below stay plain functions. */
type RecoveryContexts = {
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  route: ReturnType<typeof useRoute>
  editor: ReturnType<typeof useEditorContext>
  dialog: ReturnType<typeof useDialog>
  toast: ReturnType<typeof useToast>
  t: ReturnType<typeof useI18n>["t"]
}

/**
 * Shared recovery flow for sessions whose recorded working directory was
 * deleted on disk. Once the server reports a missing directory every
 * session-scoped request fails the same way, so both the session route and the
 * prompt funnel that failure into {@link DialogSessionDirectoryMissing} instead
 * of a raw error toast (which would also bounce the user to the home screen).
 */
export function useSessionDirectoryMissingRecovery() {
  const contexts: RecoveryContexts = {
    sdk: useSDK(),
    sync: useSync(),
    route: useRoute(),
    editor: useEditorContext(),
    dialog: useDialog(),
    toast: useToast(),
    t: useI18n().t,
  }

  return { recover: (error: unknown, sessionID?: string) => recover(contexts, error, sessionID) }
}

/**
 * Shows the recovery dialog when the error is a missing-directory failure.
 * Returns true when it was handled, so callers can skip their generic toast.
 *
 * `sessionID` should always be passed by callers that know it: the 409 body from
 * the instance API only carries the directory, so the error alone is usually not
 * enough to tell which session has to be moved.
 */
function recover(contexts: RecoveryContexts, error: unknown, sessionID?: string) {
  const details = missingDirectoryError(error)
  if (!details) return false
  // The caller-provided id wins over the (normally absent) body field.
  const target = sessionID ?? details.sessionID
  // Without a session there is nothing to migrate, and starting a fresh one here
  // would strand the old conversation — the very problem this flow exists to fix.
  // Let the caller fall back to its generic error toast instead.
  if (!target) return false
  openRecoveryDialog(contexts, target, details.directory)
  return true
}

/**
 * Opens the dialog and wires both of its outcomes. The flow ends either by moving
 * the session or by cancelling it, but the dialog reports both through the same
 * close callback, so the first outcome to settle wins: a successful move is never
 * mistaken for a dismissal and the cancel notice is shown once.
 */
function openRecoveryDialog(contexts: RecoveryContexts, sessionID: string, directory: string | undefined) {
  const settle = createSettleGuard()
  contexts.dialog.replace(
    () => (
      <DialogSessionDirectoryMissing
        directory={directory}
        onContinue={() => continueWithMove(contexts, sessionID, settle)}
      />
    ),
    // Escape, ctrl+c and a click on the backdrop only reach the close callback. Without
    // it the dialog would disappear and leave the user on a session page whose requests
    // all fail, with nothing explaining what happened.
    () => {
      if (!settle()) return
      cancelRecovery(contexts)
    },
  )
}

/** Returns a function that reports whether it is the first caller; later calls return false. */
function createSettleGuard() {
  let settled = false
  return () => {
    if (settled) return false
    settled = true
    return true
  }
}

/** Runs the move from the dialog's "continue" action; false keeps the dialog open for a retry. */
async function continueWithMove(contexts: RecoveryContexts, sessionID: string, settle: () => boolean) {
  const moved = await migrateToCurrentDirectory(contexts, sessionID)
  if (!moved) return false
  // Closing the dialog below runs its close callback; settle first so the
  // finished move is not mistaken for a dismissal.
  if (settle()) contexts.dialog.clear()
  return true
}

/**
 * Dialog cancel action: the session screen renders from the same failed requests,
 * so leaving it on screen would show an empty conversation with no way forward.
 * Go home and explain that nothing was changed.
 */
function cancelRecovery(contexts: RecoveryContexts) {
  contexts.toast.show({
    title: contexts.t("dialog.session_directory_missing_cancelled"),
    message: contexts.t("dialog.session_directory_missing_cancelled_desc"),
    variant: "info",
  })
  contexts.route.navigate({ type: "home" })
}

/**
 * Dialog continue action: migrate the session of a deleted directory into the
 * directory this client is attached to, keeping the same session id — and with it
 * the whole history.
 *
 * Recovery migrates instead of starting a new session on purpose: a fresh session
 * carries no history, so "repair the missing directory" used to feel exactly like
 * scrapping the old session (it survived on disk, but the user was dropped into an
 * empty conversation). `moveSession` rewrites the recorded directory of the
 * existing session, so the conversation simply continues here.
 *
 * `moveChanges: false` is deliberate: the source directory is gone, there is no
 * working tree left to snapshot, and the server fails while capturing a patch.
 * Skipping it loses nothing — the deleted tree is already unrecoverable and the
 * user is asking to keep working, not to salvage files.
 *
 * Resolves to false when the move failed, so the dialog stays open for a retry.
 */
async function migrateToCurrentDirectory(contexts: RecoveryContexts, sessionID: string) {
  const directory = contexts.sdk.directory
  // No destination means this client cannot offer a directory at all. Say so instead of
  // closing the dialog silently, which would look like the move had gone through.
  if (!directory) {
    contexts.toast.show({
      title: contexts.t("dialog.session_directory_missing_move_failed"),
      message: contexts.t("dialog.session_directory_missing_no_directory"),
      variant: "error",
    })
    return false
  }
  try {
    await contexts.sdk.client.experimental.controlPlane.moveSession(
      { sessionID, destination: { directory }, moveChanges: false },
      { throwOnError: true },
    )
  } catch (error) {
    reportMoveFailure(contexts, error)
    return false
  }
  await reloadMovedSession(contexts, sessionID, directory)
  // Same session id: the session continues, it only lives somewhere else now.
  contexts.route.navigate({ type: "session", sessionID })
  return true
}

/** Explains why the move failed; the caller keeps the dialog open so the user can retry. */
function reportMoveFailure(contexts: RecoveryContexts, error: unknown) {
  // Never swallow this: a silent failure would leave the dialog on screen with no hint
  // about what went wrong, and the session unusable.
  console.error("Moving the session to the current directory failed:", error)
  contexts.toast.show({
    title: contexts.t("dialog.session_directory_missing_move_failed"),
    message: errorMessage(error),
    variant: "error",
  })
}

/**
 * Rebuilds the session state after a successful move. The move keeps the session id,
 * which is why nothing reloads on its own: the session route's load effect is keyed on
 * `route.sessionID`, and navigating to the route we are already on reconciles to the
 * same store values (a no-op). Without an explicit reload the session view stays empty
 * and path formatting keeps resolving against the deleted directory, so rebuild the
 * state here the same way the route does after a load (see the createEffect in
 * packages/tui/src/routes/session/index.tsx): re-list, re-hydrate, reconnect the
 * editor, re-navigate.
 *
 * The list goes first because `sync()` only hydrates a session once: an already-loaded
 * session short-circuits it, and only the list refresh replaces the cached entry that
 * still points at the deleted directory.
 */
async function reloadMovedSession(contexts: RecoveryContexts, sessionID: string, directory: string) {
  // refresh() lists sessions without throwOnError, so a failure yields an empty list
  // instead of a rejection: there is nothing to catch here.
  await contexts.sync.session.refresh()
  try {
    await contexts.sync.session.sync(sessionID)
  } catch (error) {
    console.error("Reloading the moved session failed:", error)
  }
  try {
    contexts.editor.reconnect(directory)
  } catch (error) {
    // The dialog is already gone at this point, so an exception here would be reported as
    // an unhandled rejection and skip the navigation below, leaving the user on the old route.
    console.error("Reconnecting the editor after the move failed:", error)
  }
}
