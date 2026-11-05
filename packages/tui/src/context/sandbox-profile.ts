import { createSignal } from "solid-js"

// Module-level signal shared between dialog-sandbox (writer) and prompt (reader).
// The /sandbox dialog updates this after writing the runtime override file,
// so the prompt can display the current profile without re-reading the file.
const [currentSandboxProfile, setCurrentSandboxProfile] = createSignal<string | undefined>(undefined)

export { currentSandboxProfile, setCurrentSandboxProfile }
