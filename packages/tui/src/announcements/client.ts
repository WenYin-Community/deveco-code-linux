import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { normalizeResponse } from "./model"

const endpoint = "https://cn.devecostudio.huawei.com/sse/codeGenie/announcement"

export async function fetchAnnouncements(signal: AbortSignal) {
  const url = new URL(endpoint)
  url.searchParams.set("clientName", "deveco-code")
  url.searchParams.set("clientVersion", InstallationVersion)
  const response = await fetch(url, { method: "GET", signal })
  if (!response.ok) throw new Error(`Announcement request failed: ${response.status}`)
  const parsed = normalizeResponse(await response.json())
  if (!parsed) throw new Error("Invalid announcement response")
  return parsed
}
