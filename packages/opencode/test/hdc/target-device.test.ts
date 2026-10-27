import { describe, expect, test } from "bun:test"
import { displayLabelFor, buildTargetDeviceFact, extractExplicitTarget } from "../../src/hdc/target-device"

describe("target device fact construction (SEC1)", () => {
  test("non-device top-level queries get NoTargetDevice", () => {
    for (const argv of [["version"], ["help"], ["discover"], ["list", "targets"]]) {
      expect(buildTargetDeviceFact(argv, ["127.0.0.1:5555"])).toEqual({ selection: "not_applicable" })
    }
  })

  test("explicit -t wins over any connected-target snapshot", () => {
    const fact = buildTargetDeviceFact(["shell", "getprop", "-t", "ABC123", "ro.build"], ["127.0.0.1:5555"])
    expect(fact).toEqual({ selection: "explicit", displayLabel: "AB***23", permissionResource: "ABC123" })
  })

  test("explicit --target= serial form is recognized", () => {
    expect(extractExplicitTarget(["shell", "getprop", "--target=1.2.3.4:5555"])).toBe("1.2.3.4:5555")
  })

  test("implicit-single uses the one connected target", () => {
    const fact = buildTargetDeviceFact(["file", "send", "a.txt", "/data/local/tmp/b.txt"], ["127.0.0.1:5555"])
    expect(fact).toEqual({ selection: "implicit-single", displayLabel: "127.0.0.1:5555", permissionResource: "127.0.0.1:5555" })
  })

  test("no -t with zero or several targets falls back to raw", () => {
    expect(buildTargetDeviceFact(["file", "send", "a.txt", "/data/local/tmp/b.txt"], [])).toEqual({
      selection: "raw",
      displayLabel: "unknown",
      permissionResource: "",
    })
    expect(buildTargetDeviceFact(["file", "send", "a.txt", "/data/local/tmp/b.txt"], ["a", "b"])).toEqual({
      selection: "raw",
      displayLabel: "unknown",
      permissionResource: "",
    })
  })

  test("displayLabel keeps localhost readable and masks USB serials", () => {
    expect(displayLabelFor("127.0.0.1:5555")).toBe("127.0.0.1:5555")
    expect(displayLabelFor("localhost:5555")).toBe("localhost:5555")
    expect(displayLabelFor("ABC123")).toBe("AB***23")
    expect(displayLabelFor("ab")).toBe("**")
  })
})
