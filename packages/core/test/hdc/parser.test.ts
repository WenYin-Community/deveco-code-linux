import { describe, expect, it } from "bun:test"
import { parse, isSupportedVersion, MIN_HDC_VERSION } from "../../src/hdc/parser"
import type { HdcOperation } from "../../src/hdc/operation"

// ─── SEC2-001: 版本化解析与操作归一化 ──────────────────────
// 覆盖：表驱动解析、版本校验、capability 检测、argv 边界、unclassified

const V = "5.0.0"

describe("SEC2-001: Parser version check", () => {
  // 验证: 版本 >= MIN_HDC_VERSION (SR1 §1.4: "3.2.0c 和目标发布版本") 都被识别为支持
  it("supported versions are recognized", () => {
    for (const v of ["3.2.0c", "3.2.0d", "3.2.0f", "5.0.0", "5.0.1", "6.0.0"]) {
      expect(isSupportedVersion(v)).toBe(true)
    }
  })

  // 验证: 低于 SR1 §1.4 下限的 HDC 版本返回 runtime_incompatible, 不进入解析与策略路径
  it("below-floor version returns runtime_incompatible (§4)", () => {
    const result = parse(["shell", "ls"], "2.0.0")
    expect(result._tag).toBe("runtime_incompatible")
    if (result._tag === "runtime_incompatible") {
      expect(result.version).toBe("2.0.0")
      expect(result.supported).toContain(MIN_HDC_VERSION)
    }
  })

  // 验证: runtime_incompatible 不产生 unclassified operation 或 deny (failClosed, 不进入策略)
  it("runtime_incompatible does not produce unclassified or deny (§4)", () => {
    const result = parse(["mount"], "0.0.1")
    expect(result._tag).not.toBe("success")
  })
})

describe("SEC2-001: Parser table-driven 17 operations", () => {
  // 验证: 31 个 argv 形式通过表驱动解析映射到预期的 16 种 operation.kind (覆盖 SEC2-001 §2 全部命令)
  const cases: { name: string; argv: string[]; expectedKind: HdcOperation["kind"] }[] = [
    { name: "version", argv: ["version"], expectedKind: "versionOrHelp" },
    { name: "-v", argv: ["-v"], expectedKind: "versionOrHelp" },
    { name: "--version", argv: ["--version"], expectedKind: "versionOrHelp" },
    { name: "help", argv: ["help"], expectedKind: "versionOrHelp" },
    { name: "-h", argv: ["-h"], expectedKind: "versionOrHelp" },
    { name: "--help", argv: ["--help"], expectedKind: "versionOrHelp" },
    { name: "list targets", argv: ["list", "targets"], expectedKind: "listTargets" },
    { name: "discover", argv: ["discover"], expectedKind: "discover" },
    { name: "shell ls", argv: ["shell", "ls"], expectedKind: "shell" },
    { name: "hilog", argv: ["hilog", "-v"], expectedKind: "hilog" },
    { name: "file send", argv: ["file", "send", "/local", "/remote"], expectedKind: "fileSend" },
    { name: "file recv", argv: ["file", "recv", "/remote", "/local"], expectedKind: "fileRecv" },
    { name: "install", argv: ["install", "/pkg.hap"], expectedKind: "install" },
    { name: "uninstall", argv: ["uninstall", "com.example.app"], expectedKind: "uninstall" },
    { name: "bugreport", argv: ["bugreport"], expectedKind: "bugreport" },
    { name: "tconn", argv: ["tconn", "127.0.0.1:8080"], expectedKind: "transportConnect" },
    { name: "fport", argv: ["fport", "tcp:8080:8080"], expectedKind: "portForward" },
    { name: "rport", argv: ["rport", "tcp:8080:8080"], expectedKind: "portForward" },
    { name: "smode", argv: ["smode", "usb"], expectedKind: "modeOrDaemon" },
    { name: "tmode", argv: ["tmode", "usb"], expectedKind: "modeOrDaemon" },
    { name: "daemon", argv: ["daemon"], expectedKind: "modeOrDaemon" },
    { name: "reboot", argv: ["reboot"], expectedKind: "rebootOrBoot" },
    { name: "boot", argv: ["boot"], expectedKind: "rebootOrBoot" },
    { name: "mount (hard deny)", argv: ["mount"], expectedKind: "firmwareMutation" },
    { name: "dd (hard deny)", argv: ["dd"], expectedKind: "firmwareMutation" },
    { name: "mkfs (hard deny)", argv: ["mkfs"], expectedKind: "firmwareMutation" },
    { name: "sideload (hard deny)", argv: ["sideload"], expectedKind: "firmwareMutation" },
    { name: "update (hard deny)", argv: ["update"], expectedKind: "firmwareMutation" },
    { name: "flash (hard deny)", argv: ["flash"], expectedKind: "firmwareMutation" },
    { name: "erase (hard deny)", argv: ["erase"], expectedKind: "firmwareMutation" },
    { name: "format (hard deny)", argv: ["format"], expectedKind: "firmwareMutation" },
  ]

  for (const c of cases) {
    it(`${c.name} → kind=${c.expectedKind}`, () => {
      const result = parse(c.argv, V)
      expect(result._tag).toBe("success")
      if (result._tag === "success") {
        expect(result.operation.kind).toBe(c.expectedKind)
      }
    })
  }
})

describe("SEC2-001: Unknown option/subcommand → unclassified (§3)", () => {
  // 验证: 未知子命令 + flag + value 进入 unclassified 路径, 不抛异常
  it("unknown subcommand forms unclassified", () => {
    const result = parse(["custom-cmd", "--flag", "value"], V)
    expect(result._tag).toBe("success")
    if (result._tag === "success") {
      expect(result.operation.kind).toBe("unclassified")
    }
  })

  // 验证: list 子命令的未知子参数 → invalid_request (SR1 CON-04: 已知命令但结构不可解析)
  it("unknown list subcommand returns invalid_request (CON-04)", () => {
    const result = parse(["list", "unknown"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: 空 argv → invalid_request (CON-04: 无法形成可处理请求, fail closed)
  it("empty argv returns invalid_request (CON-04)", () => {
    const result = parse([], V)
    expect(result._tag).toBe("invalid_request")
  })
})

describe("SEC2-001: Bare interactive shell → capability_unsupported (§5)", () => {
  // 验证: 裸 hdc shell (无命令) 返回 capability_unsupported, 不进入策略
  it("bare hdc shell returns capability_unsupported", () => {
    const result = parse(["shell"], V)
    expect(result._tag).toBe("capability_unsupported")
  })

  // 验证: shell -t 但无命令也返回 capability_unsupported (交互式 shell 沙箱不支持)
  it("shell with -t but no command returns capability_unsupported", () => {
    const result = parse(["shell", "-t", "device123"], V)
    expect(result._tag).toBe("capability_unsupported")
  })

  // 验证: capability_unsupported 不是 policy deny (是非策略失败, isPolicyDeny=false)
  it("capability_unsupported is not a policy deny (§5)", () => {
    const result = parse(["shell"], V)
    expect(result._tag).not.toBe("success")
  })
})

describe("SEC2-001: Compound shell → invalid_request (guide A.1)", () => {
  // 指南 A.1: 元字符/复合 shell 不可可靠分词 → invalid_request (fail closed, not ask)
  // H1 回归: `hdc shell "echo pwn; reboot"` 曾落入 unclassified ask, 批准后设备真实重启

  // 验证: 分号复合串 (H1 复现) → invalid_request
  it("semicolon compound string returns invalid_request", () => {
    const result = parse(["shell", "echo pwn; reboot"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: 分离的分号 token 同样拒绝 (设备侧 hdc 空格拼接后解释)
  it("standalone separator token returns invalid_request", () => {
    const result = parse(["shell", "echo", "a", ";", "reboot"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: && 复合 → invalid_request
  it("logical-and compound returns invalid_request", () => {
    const result = parse(["shell", "echo a && reboot"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: 管道 → invalid_request
  it("pipe compound returns invalid_request", () => {
    const result = parse(["shell", "echo a | reboot"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: $() 命令替换 → invalid_request
  it("command substitution returns invalid_request", () => {
    const result = parse(["shell", "echo $(reboot)"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: 反引号替换 → invalid_request
  it("backtick substitution returns invalid_request", () => {
    const result = parse(["shell", "echo `reboot`"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: 子 shell 括号 → invalid_request
  it("subshell parens return invalid_request", () => {
    const result = parse(["shell", "(reboot)"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: 重定向 → invalid_request
  it("output redirection returns invalid_request", () => {
    const result = parse(["shell", "echo x > /system/f"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: 换行分隔 → invalid_request
  it("newline separator returns invalid_request", () => {
    const result = parse(["shell", "echo a\nreboot"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: 带 -t 目标旗标的复合串同样拒绝
  it("compound with target flag returns invalid_request", () => {
    const result = parse(["shell", "-t", "device123", "echo pwn; reboot"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证 (非回归): 单词 reboot 仍正常解析 (硬拒在策略层判定)
  it("plain shell command still parses", () => {
    const result = parse(["shell", "reboot"], V)
    expect(result._tag).toBe("success")
  })

  // 验证 (非回归): 多 token 普通命令不受影响
  it("multi-token plain command still parses", () => {
    const result = parse(["shell", "echo", "hello"], V)
    expect(result._tag).toBe("success")
  })

  // 验证 (非回归): aa 命令不被复合检测拦截
  it("aa command still parses as appControl", () => {
    const result = parse(["shell", "aa", "start", "-a", "MainAbility", "-b", "com.example.app"], V)
    expect(result._tag).toBe("success")
    if (result._tag === "success") expect(result.operation.kind).toBe("appControl")
  })

  // 验证 (非回归): 环境变量展开 $VAR (无括号) 不误伤
  it("environment variable expansion is not rejected", () => {
    const result = parse(["shell", "echo", "$HOME"], V)
    expect(result._tag).toBe("success")
  })
})

describe("SEC2-001: Dangling global flag → invalid_request (guide A.1, L1)", () => {
  // L1 回归: `hdc -t` (缺 connect key) 曾落入 unclassified → target_device_ambiguous
  // 指南 A.1: 缺操作数属于结构不可解析 → invalid_request (fail closed)

  // 验证: 裸 -t 缺值 → invalid_request
  it("bare -t without value returns invalid_request", () => {
    const result = parse(["-t"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: 裸 -s 缺值 → invalid_request
  it("bare -s without value returns invalid_request", () => {
    const result = parse(["-s"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证 (非回归): 带值全局旗标仍正常剥离并派发子命令
  it("-t with value still strips and dispatches", () => {
    const result = parse(["-t", "device123", "version"], V)
    expect(result._tag).toBe("success")
  })

  // 验证: 有效旗标后尾部悬挂 -s → invalid_request (剥离后无子命令)
  it("trailing dangling -s after valid flags returns invalid_request", () => {
    const result = parse(["-t", "device123", "-s"], V)
    expect(result._tag).toBe("invalid_request")
  })
})

describe("SEC2-001: Structurally unparseable argv → invalid_request (CON-04)", () => {
  // SR1 CON-04: 已知命令但必要字段缺失或结构异常 → invalid_request (fail closed, not ask)
  // 与 unclassified (未知命令, argv 结构完整可安全携带 → ask 兜底) 区分

  // 验证: file 缺少路径参数 → invalid_request
  it("file with insufficient args returns invalid_request", () => {
    const result = parse(["file"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: file 未知子命令 → invalid_request
  it("file with unknown subcommand returns invalid_request", () => {
    const result = parse(["file", "sync", "a", "b"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: install 缺少 package path → invalid_request
  it("install without package path returns invalid_request", () => {
    const result = parse(["install", "-r"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: uninstall 缺少 bundle name → invalid_request
  it("uninstall without bundle name returns invalid_request", () => {
    const result = parse(["uninstall", "-n"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: tconn 缺少 endpoint → invalid_request
  it("tconn without endpoint returns invalid_request", () => {
    const result = parse(["tconn"], V)
    expect(result._tag).toBe("invalid_request")
  })

  // 验证: invalid_request 不产生 success 或 unclassified (不进入 ask 兜底)
  it("invalid_request is not success or unclassified", () => {
    const result = parse(["file"], V)
    expect(result._tag).not.toBe("success")
  })
})

describe("SEC2-001: argv boundary preservation (§2)", () => {
  // 验证: unclassified operation 保留原始 argv (originalArgv 字段完整)
  it("unclassified preserves originalArgv", () => {
    const argv = ["custom", "--flag", "value"]
    const result = parse(argv, V)
    if (result._tag === "success" && result.operation.kind === "unclassified") {
      expect(result.operation.originalArgv).toEqual(argv)
    }
  })

  // 验证: shell operation 保留设备端 argv (deviceArgv 字段)
  it("shell preserves deviceArgv", () => {
    const result = parse(["shell", "getprop", "ro.build.version"], V)
    if (result._tag === "success" && result.operation.kind === "shell") {
      expect(result.operation.deviceArgv).toEqual(["getprop", "ro.build.version"])
    }
  })

  // 验证: shell aa start 提取 bundle name 并生成 appControl operation
  it("shell aa start extracts bundle name", () => {
    const result = parse(["shell", "aa", "start", "-b", "com.example.app"], V)
    if (result._tag === "success" && result.operation.kind === "appControl") {
      expect(result.operation.action).toBe("aa start")
      expect(result.operation.bundleName).toBe("com.example.app")
    }
  })

  // 验证: aa force-stop 支持位置参数 bundle (真实 hdc 语法, Windows 验证 L3)
  it("shell aa force-stop extracts positional bundle name", () => {
    const result = parse(["shell", "aa", "force-stop", "com.example.app"], V)
    expect(result._tag).toBe("success")
    if (result._tag === "success" && result.operation.kind === "appControl") {
      expect(result.operation.action).toBe("aa force-stop")
      expect(result.operation.bundleName).toBe("com.example.app")
    }
  })

  // 验证: aa force-stop 的 -b 形式仍支持 (非回归)
  it("shell aa force-stop still supports -b form", () => {
    const result = parse(["shell", "aa", "force-stop", "-b", "com.example.app"], V)
    expect(result._tag).toBe("success")
    if (result._tag === "success" && result.operation.kind === "appControl") {
      expect(result.operation.bundleName).toBe("com.example.app")
    }
  })

  // 验证: aa stop 不支持位置参数 (真实 hdc 语法需 -b), 不误提取
  it("shell aa stop does not extract positional bundle", () => {
    const result = parse(["shell", "aa", "stop", "com.example.app"], V)
    expect(result._tag).toBe("success")
    if (result._tag === "success" && result.operation.kind === "appControl") {
      expect(result.operation.action).toBe("aa stop")
      expect(result.operation.bundleName).toBeUndefined()
    }
  })

  // 验证: shell bm uninstall 被归一化为 uninstall operation (而非 shell)
  it("shell bm uninstall extracts bundle name", () => {
    const result = parse(["shell", "bm", "uninstall", "-n", "com.example.app"], V)
    if (result._tag === "success" && result.operation.kind === "uninstall") {
      expect(result.operation.bundleName).toBe("com.example.app")
    }
  })

  // 验证: file send 带 -t device 选择器时跳过设备参数, 正确提取 local/remote 路径
  it("file send with -t selector skips device arg", () => {
    const result = parse(["file", "send", "-t", "dev1", "/local/path", "/remote/path"], V)
    if (result._tag === "success" && result.operation.kind === "fileSend") {
      expect(result.operation.localPath).toBe("/local/path")
      expect(result.operation.remotePath).toBe("/remote/path")
    }
  })

  // 验证: file recv 带 -t device 选择器时正确提取 remote/local 路径
  it("file recv with -t selector skips device arg", () => {
    const result = parse(["file", "recv", "-t", "dev1", "/remote/path", "/local/path"], V)
    if (result._tag === "success" && result.operation.kind === "fileRecv") {
      expect(result.operation.remotePath).toBe("/remote/path")
      expect(result.operation.localPath).toBe("/local/path")
    }
  })

  // 验证: install 带 -r flag 时正确提取 packagePath (flag 不干扰路径提取)
  it("install with -r flag extracts package path", () => {
    const result = parse(["install", "-r", "/workspace/app.hap"], V)
    if (result._tag === "success" && result.operation.kind === "install") {
      expect(result.operation.packagePath).toBe("/workspace/app.hap")
    }
  })

  // 验证: fport direction=forward (正向端口转发)
  it("fport direction=forward", () => {
    const result = parse(["fport", "tcp:8080:8080"], V)
    if (result._tag === "success" && result.operation.kind === "portForward") {
      expect(result.operation.direction).toBe("forward")
    }
  })

  // 验证: rport direction=reverse (反向端口转发)
  it("rport direction=reverse", () => {
    const result = parse(["rport", "tcp:8080:8080"], V)
    if (result._tag === "success" && result.operation.kind === "portForward") {
      expect(result.operation.direction).toBe("reverse")
    }
  })

  // 验证: firmwareMutation operation 保留原始 command (mount/dd/mkfs 等)
  it("firmwareMutation preserves command", () => {
    const result = parse(["mount"], V)
    if (result._tag === "success" && result.operation.kind === "firmwareMutation") {
      expect(result.operation.command).toBe("mount")
    }
  })
})

describe("SEC2-001/004: categoryOf mapping", () => {
  // 验证: versionOrHelp → 非设备查询分类 non_device_query
  it("versionOrHelp → non_device_query", () => {
    const op: HdcOperation = { kind: "versionOrHelp" }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("non_device_query")
  })

  // 验证: listTargets → 非设备查询分类 non_device_query
  it("listTargets → non_device_query", () => {
    const op: HdcOperation = { kind: "listTargets" }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("non_device_query")
  })

  // 验证: shell getprop (只读查询) → device_readonly
  it("shell getprop → device_readonly", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["getprop", "ro.build.version"], interactive: false }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("device_readonly")
  })

  // 验证: shell param set (修改系统参数) → param_change
  it("shell param set → param_change", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["param", "set", "key", "val"], interactive: false }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("param_change")
  })

  // 验证: shell rm (文件删除) → device_file_change
  it("shell rm → device_file_change", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["rm", "/data/file"], interactive: false }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("device_file_change")
  })

  // 验证: shell aa start (应用启动) → app_lifecycle
  it("shell aa start → app_lifecycle", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["aa", "start", "-b", "com.example"], interactive: false }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("app_lifecycle")
  })

  // 验证: install → install_start
  it("install → install_start", () => {
    const op: HdcOperation = { kind: "install", packagePath: "/app.hap" }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("install_start")
  })

  // 验证: fileSend → file_transfer
  it("fileSend → file_transfer", () => {
    const op: HdcOperation = { kind: "fileSend", localPath: "/l", remotePath: "/r" }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("file_transfer")
  })

  // 验证: uninstall → app_lifecycle (应用生命周期)
  it("uninstall → app_lifecycle", () => {
    const op: HdcOperation = { kind: "uninstall", bundleName: "com.example" }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("app_lifecycle")
  })

  // 验证: bugreport → diagnostic
  it("bugreport → diagnostic", () => {
    const op: HdcOperation = { kind: "bugreport", localPath: undefined }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("diagnostic")
  })

  // 验证: transportConnect → connection_forward
  it("transportConnect → connection_forward", () => {
    const op: HdcOperation = { kind: "transportConnect", endpoint: "127.0.0.1:8080" }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("connection_forward")
  })

  // 验证: portForward → connection_forward
  it("portForward → connection_forward", () => {
    const op: HdcOperation = { kind: "portForward", direction: "forward", args: ["tcp:8080:8080"] }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("connection_forward")
  })

  // 验证: modeOrDaemon → system_state
  it("modeOrDaemon → system_state", () => {
    const op: HdcOperation = { kind: "modeOrDaemon", action: "smode" }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("system_state")
  })

  // 验证: rebootOrBoot → system_state
  it("rebootOrBoot → system_state", () => {
    const op: HdcOperation = { kind: "rebootOrBoot" }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("system_state")
  })

  // 验证: shell reboot → system_state (F.6: hdc shell reboot/shutdown must be system_state, not unclassified)
  it("shell reboot → system_state", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["reboot"], interactive: false }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("system_state")
  })

  it("shell shutdown → system_state", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["shutdown"], interactive: false }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("system_state")
  })

  it("shell poweroff → system_state", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["poweroff"], interactive: false }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("system_state")
  })

  // 验证: firmwareMutation → firmware_mutation
  it("firmwareMutation → firmware_mutation", () => {
    const op: HdcOperation = { kind: "firmwareMutation", command: "mount" }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("firmware_mutation")
  })

  // 验证: unclassified → unclassified (兜底分类保持一致)
  it("unclassified → unclassified", () => {
    const op: HdcOperation = { kind: "unclassified", originalArgv: ["unknown"] }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("unclassified")
  })

  // 验证: hilog (日志查询) → device_readonly
  it("hilog → device_readonly", () => {
    const op: HdcOperation = { kind: "hilog", args: ["-v"] }
    const { categoryOf } = require("../../src/hdc/operation")
    expect(categoryOf(op)).toBe("device_readonly")
  })
})
