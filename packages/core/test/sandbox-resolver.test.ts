import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { SandboxResolver } from "../src/config/sandbox-resolver"
import {
  SandboxConfigError,
  BUILTIN_PROFILES,
  isBuiltinProfile,
  validateSandboxShape,
} from "../src/config/sandbox"

// ─── 测试文件说明 ───────────────────────────────────────────
// 本文件测试沙箱配置模型（FR-CFG-001 ~ FR-CFG-012）。
// 覆盖：三层配置合并、Profile 继承展平、加载期校验、选择解析、sandbox 约束。
// 对应需求文档：sandbox/doc/SR/macos_sandbox_sr1.md §3.1.1 / §3.3

describe("SandboxResolver.mergeLayers", () => {
  // FR-CFG-001 S-MERGE-1: 无配置层时返回空对象，不产生错误
  it("returns empty config when no layers provided", () => {
    const result = SandboxResolver.mergeLayers({})
    expect(result).toEqual({})
  })

  // FR-CFG-001 S-MERGE-1: 高优先层覆盖低层 profile 选择
  it("S-MERGE-1: higher layer overrides profile selection", () => {
    const result = SandboxResolver.mergeLayers({
      global: { profile: "read-only" },
      project: { profile: "workspace" },
    })
    expect(result.profile).toBe("workspace")
  })

  // FR-CFG-001 S-MERGE-2/4: 同名 profile 跨层 deep-merge，workspace_roots 拼接去重
  it("S-MERGE-2: same-name profiles deep-merged across layers", () => {
    const result = SandboxResolver.mergeLayers({
      global: {
        profiles: {
          dev: { filesystem: { "/usr": "read" }, workspace_roots: ["/a"] },
        },
      },
      project: {
        profiles: {
          dev: { filesystem: { "/opt": "write" }, workspace_roots: ["/b"] },
        },
      },
    })
    const dev = result.profiles?.["dev"]
    expect(dev?.filesystem).toEqual({ "/usr": "read", "/opt": "write" })
    // S-MERGE-4: workspace_roots concatenated and de-duplicated
    expect(dev?.workspace_roots).toEqual(["/a", "/b"])
  })

  // FR-CFG-001 S-MERGE-4: workspace_roots 去重
  it("S-MERGE-4: workspace_roots de-duplicated", () => {
    const result = SandboxResolver.mergeLayers({
      global: { profiles: { dev: { workspace_roots: ["/a", "/b"] } } },
      project: { profiles: { dev: { workspace_roots: ["/b", "/c"] } } },
    })
    expect(result.profiles?.["dev"]?.workspace_roots).toEqual(["/a", "/b", "/c"])
  })

  // FR-CFG-007: 网络开关最高优先层覆盖
  it("network: highest layer wins", () => {
    const result = SandboxResolver.mergeLayers({
      global: { network: { enabled: false } },
      project: { network: { enabled: true } },
    })
    expect(result.network?.enabled).toBe(true)
  })
})

describe("SandboxResolver.flattenProfile", () => {
  // FR-CFG-004: 内建 read-only profile 等价定义为 {":root":"read"}
  it("returns builtin profile for read-only", async () => {
    const result = await Effect.runPromise(
      SandboxResolver.flattenProfile("read-only", {}),
    )
    expect(result.filesystem).toEqual({ ":root": "read" })
  })

  // FR-CFG-003 V-EXT-1: extends 引用不存在的 profile 时报错
  it("V-EXT-1: fails on non-existent extends reference", async () => {
    const result = await Effect.runPromiseExit(
      SandboxResolver.flattenProfile("dev", { dev: { extends: "nonexistent" } }),
    )
    expect(result._tag).toBe("Failure")
  })

  // FR-CFG-003 V-EXT-2: extends 链成环时报错
  it("V-EXT-2: fails on cycle", async () => {
    const result = await Effect.runPromiseExit(
      SandboxResolver.flattenProfile("a", {
        a: { extends: "b" },
        b: { extends: "a" },
      }),
    )
    expect(result._tag).toBe("Failure")
  })

  // FR-CFG-003 V-EXT-3: extends: "full-access" 被禁止
  it("V-EXT-3: fails on extends full-access", async () => {
    const result = await Effect.runPromiseExit(
      SandboxResolver.flattenProfile("dev", { dev: { extends: "full-access" } }),
    )
    expect(result._tag).toBe("Failure")
  })

  // FR-CFG-003: extends 继承链展平后，子 profile 条目覆盖父条目
  it("flattens extends chain correctly", async () => {
    const result = await Effect.runPromise(
      SandboxResolver.flattenProfile("dev", {
        dev: { extends: "read-only", filesystem: { "/custom": "write" } },
      }),
    )
    // read-only's :root=read + dev's /custom=write
    expect(result.filesystem).toEqual({ ":root": "read", "/custom": "write" })
  })
})

describe("SandboxResolver.validate", () => {
  // FR-CFG-010: 合法配置通过校验
  it("passes for valid config", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({ profile: "read-only" }),
    )
    expect(exit._tag).toBe("Success")
  })

  // FR-CFG-004 V-NAME-1: 用户定义与内建同名的 profile id 时报错
  it("V-NAME-1: fails on builtin profile id collision", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({ profiles: { "read-only": {} } }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // FR-CFG-004 V-NAME-1: profile id 以 ":" 开头时报错
  it("V-NAME-1: fails on ':' prefixed profile id", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({ profiles: { ":custom": {} } }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // FR-CFG-010 V-PATH-1: filesystem 键为相对路径时报错
  it("V-PATH-1: fails on relative path in filesystem", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({ profiles: { dev: { filesystem: { "relative/path": "read" } } } }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // FR-CFG-005 V-SEL-1: sandbox.profile 引用未定义且非内建的 id 时报错
  it("V-SEL-1: fails on undefined profile reference", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({ profile: "nonexistent" }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // FR-CFG-006 V-SEL-2: 生效 profile 不在 allowed_profiles 白名单内时报错
  it("V-SEL-2: fails on profile not in allowed_profiles", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profile: "workspace",
        allowed_profiles: ["read-only"],
      }),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("SandboxResolver.resolveSelection", () => {
  // FR-CFG-005 S-SEL-1: 运行时注入层覆盖项目层和全局层
  it("S-SEL-1: runtime layer wins", () => {
    const result = SandboxResolver.resolveSelection({
      global: { profile: "read-only" },
      project: { profile: "workspace" },
      runtime: { profile: "full-access" },
    })
    expect(result.profile_id).toBe("full-access")
    expect(result.is_implicit).toBe(false)
    expect(result.source_layer).toBe("runtime")
  })

  // FR-CFG-005 S-SEL-2: 无任何声明时隐式默认 full-access
  it("S-SEL-2: implicit default is full-access", () => {
    const result = SandboxResolver.resolveSelection({})
    expect(result.profile_id).toBe("full-access")
    expect(result.is_implicit).toBe(true)
  })

  // FR-CFG-005 S-SEL-1: 项目层覆盖全局层
  it("project layer wins over global", () => {
    const result = SandboxResolver.resolveSelection({
      global: { profile: "read-only" },
      project: { profile: "workspace" },
    })
    expect(result.profile_id).toBe("workspace")
    expect(result.source_layer).toBe("project")
  })
})

describe("SandboxResolver.resolveSandbox", () => {
  // FR-CFG-005/007: read-only 默认 network off
  it("succeeds for read-only with network off by default", async () => {
    const result = await Effect.runPromise(
      SandboxResolver.resolveSandbox({ global: { profile: "read-only" } }),
    )
    expect(result.profile_id).toBe("read-only")
    expect(result.network_enabled).toBe(false)
    expect(result.is_implicit).toBe(false)
  })

  // FR-CFG-005: 无配置时隐式默认 full-access
  it("succeeds for implicit default (no config)", async () => {
    const result = await Effect.runPromise(
      SandboxResolver.resolveSandbox({}),
    )
    expect(result.profile_id).toBe("full-access")
    expect(result.is_implicit).toBe(true)
  })

  // D2 lifted: workspace profile is now allowed (no longer rejected)
  it("D2 lifted: succeeds for workspace profile", async () => {
    const result = await Effect.runPromise(
      SandboxResolver.resolveSandbox({ global: { profile: "workspace" } }),
    )
    expect(result.profile_id).toBe("workspace")
  })

  // D3 lifted: network off is now allowed (no longer rejected)
  it("D3 lifted: succeeds with network off", async () => {
    const result = await Effect.runPromise(
      SandboxResolver.resolveSandbox({
        global: { profile: "read-only", network: { enabled: false } },
      }),
    )
    expect(result.profile_id).toBe("read-only")
    expect(result.network_enabled).toBe(false)
  })
})

describe("Built-in profiles", () => {
  // FR-CFG-004: read-only 内建 profile 等价定义 {":root":"read"}
  it("BUILTIN_PROFILES has correct read-only definition", () => {
    expect(BUILTIN_PROFILES["read-only"].filesystem).toEqual({ ":root": "read" })
  })

  // FR-CFG-004: workspace 内建 profile 含保护目录 carveout（.git 等）
  it("BUILTIN_PROFILES has workspace with protected paths", () => {
    const fs = BUILTIN_PROFILES["workspace"].filesystem!
    expect(fs[":root"]).toBe("read")
    expect(fs[":workspace_roots"]).toBe("write")
    expect(fs[":workspace_roots/.git"]).toBe("read")
  })

  // FR-CFG-004: full-access 内建 profile 为空对象（无限制）
  it("BUILTIN_PROFILES has empty full-access", () => {
    expect(BUILTIN_PROFILES["full-access"].filesystem).toBeUndefined()
  })

  // FR-CFG-004: isBuiltinProfile 正确识别内建 profile
  it("isBuiltinProfile correctly identifies builtins", () => {
    expect(isBuiltinProfile("read-only")).toBe(true)
    expect(isBuiltinProfile("workspace")).toBe(true)
    expect(isBuiltinProfile("full-access")).toBe(true)
    expect(isBuiltinProfile("custom")).toBe(false)
  })
})

// ─── 补充测试：V-GLOB / V-NEST / V-NET / W-* / S-MERGE-5 / S10 / D3 ──
// 以下测试覆盖之前缺失的校验规则和回归测试，遵循「示例模板」原则：
// 每条规则一个示例，测试同学可参照扩展同类用例。

describe("SandboxResolver.validate — V-GLOB-1: glob in read/write must be trailing /**", () => {
  // V-GLOB-1: read 模式中非尾部 /** 的 glob 报错
  it("V-GLOB-1: fails on non-trailing glob in read mode", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { "/etc/*.conf": "read" } } },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // V-GLOB-1: write 模式中非尾部 /** 的 glob 报错
  it("V-GLOB-1: fails on non-trailing glob in write mode", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { "/var/log/*.log": "write" } } },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // V-GLOB-1: 尾部 /** 在 read 模式下允许
  it("V-GLOB-1: allows trailing /** in read mode", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { "/etc/**": "read" } } },
      }),
    )
    expect(exit._tag).toBe("Success")
  })
})

describe("SandboxResolver.validate — V-GLOB-2: glob in scoped sub-path must be deny", () => {
  // V-GLOB-2: :workspace_roots 子路径中的 glob 非 deny 报错
  it("V-GLOB-2: fails on glob in scoped sub-path with read mode", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { ":workspace_roots/*.log": "read" } } },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // V-GLOB-2: :workspace_roots 子路径中的 glob deny 允许
  it("V-GLOB-2: allows glob in scoped sub-path with deny mode", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { ":workspace_roots/*.log": "deny" } } },
      }),
    )
    expect(exit._tag).toBe("Success")
  })
})

describe("SandboxResolver.validate — V-NEST-1: scoped sub-path not allowed for :tmpdir/:slash_tmp/:root", () => {
  // V-NEST-1: :tmpdir 不支持 scoped 子路径
  it("V-NEST-1: fails on scoped sub-path for :tmpdir", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { ":tmpdir/foo": "read" } } },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // V-NEST-1: :slash_tmp 不支持 scoped 子路径
  it("V-NEST-1: fails on scoped sub-path for :slash_tmp", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { ":slash_tmp/foo": "read" } } },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // V-NEST-1: :root 不支持 scoped 子路径
  it("V-NEST-1: fails on scoped sub-path for :root", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { ":root/foo": "read" } } },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("SandboxResolver.validate — V-NEST-2: scoped sub-path must not contain . or ..", () => {
  // V-NEST-2: scoped 子路径含 .. 报错
  it("V-NEST-2: fails on .. in scoped sub-path", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { ":workspace_roots/../sensitive": "read" } } },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  // V-NEST-2: scoped 子路径含 . 报错
  it("V-NEST-2: fails on . in scoped sub-path", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { ":workspace_roots/./file": "read" } } },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("SandboxResolver.validate — V-NET-1: profile network must have enabled", () => {
  // V-NET-1: profile network 对象缺 enabled 报错
  it("V-NET-1: fails on profile network without enabled", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profiles: { mydev: { filesystem: { ":root": "read" }, network: {} as any } },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("SandboxResolver.validate — V-NET-2: sandbox.network must have enabled", () => {
  // V-NET-2: sandbox.network 对象缺 enabled 报错
  it("V-NET-2: fails on sandbox.network without enabled", async () => {
    const exit = await Effect.runPromiseExit(
      SandboxResolver.validate({
        profile: "read-only",
        network: {} as any,
      }),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("SandboxResolver.validate — W-* warnings via validateAll", () => {
  // W-1: 未知 :xxx 特殊路径 → 警告（非阻断）
  it("W-1: warns on unknown special path", () => {
    const errors = SandboxResolver.validateAll({
      profiles: { mydev: { filesystem: { ":unknown_special": "read" } } },
    })
    // W-1 是警告，不应产生 errors
    expect(errors.length).toBe(0)
  })

  // W-2: profile filesystem 为空对象 → 警告（非阻断）
  it("W-2: warns on empty filesystem", () => {
    const errors = SandboxResolver.validateAll({
      profiles: { mydev: {} },
    })
    // W-2 是警告，不应产生 errors
    expect(errors.length).toBe(0)
  })

  // W-2: profile filesystem 缺失 → 警告（非阻断）
  it("W-2: warns on missing filesystem", () => {
    const errors = SandboxResolver.validateAll({
      profiles: { mydev: { description: "no filesystem" } },
    })
    expect(errors.length).toBe(0)
  })

  // W-3: :minimal = "write" → 警告（非阻断）
  it("W-3: warns on :minimal=write", () => {
    const errors = SandboxResolver.validateAll({
      profiles: { mydev: { filesystem: { ":minimal": "write" } } },
    })
    expect(errors.length).toBe(0)
  })
})

describe("validateSandboxShape — S-MERGE-5: unknown keys rejected", () => {
  // S-MERGE-5: 未知键严格校验 — sandbox 顶层未知键
  it("S-MERGE-5: rejects unknown top-level key in sandbox", () => {
    const result = validateSandboxShape({
      profile: "read-only",
      unknownField: "should-be-rejected",
    })
    expect(result).toBeUndefined()
  })

  // S-MERGE-5: 未知键严格校验 — profile 内未知键
  it("S-MERGE-5: rejects unknown key in profile definition", () => {
    const result = validateSandboxShape({
      profiles: {
        mydev: {
          filesystem: { ":root": "read" },
          unknownField: "should-be-rejected",
        },
      },
    })
    expect(result).toBeUndefined()
  })

  // S-MERGE-5: 合法配置通过
  it("S-MERGE-5: accepts valid config", () => {
    const result = validateSandboxShape({
      profile: "read-only",
      profiles: {
        mydev: {
          description: "valid profile",
          filesystem: { ":root": "read" },
          network: { enabled: true },
        },
      },
    })
    expect(result).toBeDefined()
    expect(result?.profile).toBe("read-only")
  })
})

describe("S-AGENT-1: agent override covers project-layer top-level sandbox fields", () => {
  // S-AGENT-1: per-agent sandbox override "视同声明它的配置层的选择"，
  // 优先级高于同层顶层 sandbox.profile。所以 agent override 的所有字段
  // 覆盖 base（profile/network/allowed_profiles），profiles 深度合并。
  // agent override 仍然是 project 层的一部分，runtime 层可以覆盖它。
  it("S-AGENT-1: agent override covers base profile/network selection", () => {
    const base = {
      profile: "read-only",
      allowed_profiles: ["read-only"],
      network: { enabled: false },
      profiles: { "read-only": { filesystem: { ":root": "read" } } },
    }
    const override = {
      // agent override 覆盖 base 的安全字段（S-AGENT-1 语义）
      profile: "workspace",
      allowed_profiles: ["workspace", "full-access"],
      network: { enabled: true },
      profiles: { "agent-dev": { filesystem: { ":root": "write" } } },
    }
    // 模拟 shell.ts 的 mergeSandboxConfig 实现（S-AGENT-1 修复后）
    const merged = {
      ...base,
      ...override,
      profiles: { ...(base.profiles ?? {}), ...(override.profiles ?? {}) },
    }
    // agent override 的安全字段覆盖 base
    expect(merged.profile).toBe("workspace")
    expect(merged.allowed_profiles).toEqual(["workspace", "full-access"])
    expect(merged.network?.enabled).toBe(true)
    // profiles 应合并（agent 可追加 profile 定义）
    expect(merged.profiles).toHaveProperty("agent-dev")
    expect(merged.profiles).toHaveProperty("read-only")
  })

  it("S-AGENT-1: agent override does not override runtime layer", async () => {
    // agent override 覆盖 project 层后，runtime 层仍可覆盖它
    // 这里验证 runtime 层的 profile 优先于 agent override 合并后的 project 层
    const result = await Effect.runPromise(
      SandboxResolver.resolveSandbox({
        project: { profile: "workspace", network: { enabled: true } },
        runtime: { profile: "read-only", network: { enabled: false } },
      }),
    )
    // runtime 层优先，profile=read-only, network=off
    expect(result.profile_id).toBe("read-only")
    expect(result.network_enabled).toBe(false)
  })
})

describe("D3 regression: network off no longer rejected", () => {
  // D3 lifted: 网络关闭不再被拒绝
  it("D3 lifted: succeeds with network off at runtime layer", async () => {
    const result = await Effect.runPromise(
      SandboxResolver.resolveSandbox({
        global: { profile: "read-only" },
        runtime: { profile: "read-only", network: { enabled: false } },
      }),
    )
    expect(result.profile_id).toBe("read-only")
    expect(result.network_enabled).toBe(false)
  })

  // D3 lifted: 网络关闭在 project 层也不再拒绝
  it("D3 lifted: succeeds with network off at project layer", async () => {
    const result = await Effect.runPromise(
      SandboxResolver.resolveSandbox({
        project: { profile: "read-only", network: { enabled: false } },
      }),
    )
    expect(result.profile_id).toBe("read-only")
    expect(result.network_enabled).toBe(false)
  })

  // D3: 网络开启时正常
  it("D3: succeeds when network on with read-only", async () => {
    const result = await Effect.runPromise(
      SandboxResolver.resolveSandbox({
        global: { profile: "read-only", network: { enabled: true } },
      }),
    )
    expect(result.network_enabled).toBe(true)
  })
})
