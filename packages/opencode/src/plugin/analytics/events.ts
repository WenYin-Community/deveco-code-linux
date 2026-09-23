import os from "os"
import { Runtime } from "@opencode-ai/core/runtime"
import type { AnalyticsEnvironmentFields } from "./types"

export function createEnvironmentFields(sourceVersion: string): AnalyticsEnvironmentFields {
  return {
    ...Runtime.getAnalyticsSource(sourceVersion),
    os_arch: os.arch(),
    os_name: process.platform,
    os_version: os.release(),
  }
}
