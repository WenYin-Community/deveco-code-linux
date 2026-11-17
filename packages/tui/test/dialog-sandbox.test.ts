import { describe, expect, test } from "bun:test"
import { windowsProfileValidationError } from "../src/component/dialog-sandbox"

describe("windowsProfileValidationError", () => {
  test("accepts a profile derived from workspace", () => {
    expect(
      windowsProfileValidationError(
        {
          profiles: {
            protected: {
              extends: "workspace",
              filesystem: { ":workspace_roots/secrets": "read" },
            },
          },
        },
        "protected",
      ),
    ).toBeUndefined()
  })

  test("rejects a configured profile that does not extend workspace", () => {
    expect(
      windowsProfileValidationError(
        {
          profiles: {
            custom: { filesystem: { ":root": "read" } },
          },
        },
        "custom",
      ),
    ).toMatchObject({
      rule: "V-WIN-PROFILE-1",
      path: "sandbox.profiles.custom.extends",
    })
  })

  test("rejects unsupported write access in a workspace-derived profile", () => {
    expect(
      windowsProfileValidationError(
        {
          profiles: {
            expanded: {
              extends: "workspace",
              filesystem: { "C:\\outside": "write" },
            },
          },
        },
        "expanded",
      ),
    ).toMatchObject({ rule: "V-WIN-FS-1" })
  })
})
