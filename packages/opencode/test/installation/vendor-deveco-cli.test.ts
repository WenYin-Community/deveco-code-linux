import { describe, expect, test } from "bun:test"
import { resolveDevecoCliVersionFromPackageJson } from "../../script/vendor-deveco-cli"

describe("deveco-cli vendor dependency", () => {
  test("preserves the package and version of an npm alias", () => {
    expect(
      resolveDevecoCliVersionFromPackageJson({
        dependencies: { "@deveco/deveco-cli": "npm:@deveco-test/deveco-cli@1.3.11-Test.5" },
      }),
    ).toBe("npm:@deveco-test/deveco-cli@1.3.11-Test.5")
  })

  test("accepts a direct version", () => {
    expect(resolveDevecoCliVersionFromPackageJson({ dependencies: { "@deveco/deveco-cli": "1.3.4" } })).toBe("1.3.4")
  })

  test("rejects a missing dependency", () => {
    expect(() => resolveDevecoCliVersionFromPackageJson({})).toThrow('Missing dependency "@deveco/deveco-cli"')
  })
})
