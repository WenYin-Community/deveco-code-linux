import type { Hooks } from "@opencode-ai/plugin"

// The published Harness predates the host's verification-policy update. Keep
// only the policy delta here, rather than bringing back native SDD resources.
const VERIFICATION_POLICY = `
# Current host verification policy (takes precedence over older workflow text)
For build+ui, run each story sequentially with at most 2 verification attempts
(1 initial + 1 retry), always freshStart=true. Do not run a separate final pass.
Report the per-story results as authoritative. One failure-triage rerun per
story is exempt from this attempt counter. For build+ui-simplified, the
ui-verification-with-deeplink Skill owns its retry limit, final pass and cleanup.
Generate cases only for observable UI: no actual media playback, sensor checks,
permission flows, system screens or real-time waits >=3 seconds. For camera,
gallery, QR and OCR, check only the entry and that tapping does not crash or blank
the screen. Games and gestures get a first-screen/primary-action smoke check.
If underlying behaviour is outside these capabilities, verify the UI surface
and explicitly mark the underlying behaviour out of scope.
Screenshot reading depends on the configured model's image-input capability.
If read reports text-only input, use recognize_ui_components or the layout tree;
do not retry read or take another screenshot. verify_ui uses its own model.
`

export function adaptHarnessHooks(hooks: Hooks): Hooks {
  return {
    ...hooks,
    config: async (config) => {
      await hooks.config?.(config)
      // Newer Harness releases can ship this policy themselves. Preserve user
      // replacements and stop applying the delta once the old wording is gone.
      const command = config.command?.["spec-verify"]
      const prompt = config.agent?.["spec-verify"]?.prompt
      if (!command?.template?.includes("maximum of 3 total verification attempts") && !prompt?.includes("Phase 2"))
        return
      if (command && !command.template.includes("# Current host verification policy"))
        command.template += VERIFICATION_POLICY
      for (const name of ["goal", "spec-verify"]) {
        const agent = config.agent?.[name]
        if (agent?.prompt && !agent.prompt.includes("# Current host verification policy"))
          agent.prompt += VERIFICATION_POLICY
      }
    },
  }
}
