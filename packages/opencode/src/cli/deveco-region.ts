import { UI } from "@/cli/ui"
import { MAINLAND_CHINA_ONLY_MESSAGE, regionPolicy } from "@/plugin/deveco/region-policy"

export async function ensureMainlandChinaCliAccess(): Promise<boolean> {
  const region = await regionPolicy.checkAccess()
  if (region.allowed) return true

  UI.error(MAINLAND_CHINA_ONLY_MESSAGE)
  process.exitCode = 1
  return false
}
