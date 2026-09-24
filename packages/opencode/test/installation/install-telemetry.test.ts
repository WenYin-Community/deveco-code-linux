import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const installTelemetryContract = {
  endpoint: "https://cn.devecostudio.huawei.com/codeGenie/cli/trace/upload",
  headers: {
    contentType: "application/json",
    sender: "deveco-installer",
    deviceID: "deviceid",
  },
  actions: {
    installStarted: "DevEcoCodeInstallStarted",
    downloadFinished: "DevEcoCodeDownloadFinished",
    installFinished: "DevEcoCodeInstallFinished",
  },
  limits: {
    batchSize: 200,
    payloadBytes: 1_782_579,
    connectTimeoutSeconds: 1,
    requestTimeoutSeconds: 2,
  },
  testEndpointEnvironment: "DEVECO_INSTALLER_TELEMETRY_ENDPOINT",
  testEndpointHosts: ["127.0.0.1", "localhost", "::1"],
  schemaVersion: 1,
  installerRevision: "install-telemetry-v1",
  fields: {
    event: ["action", "detail", "timestamp"],
    detail: ["trace_uuid", "session_id", "event_detail"],
    installStarted: [
      "schema_version",
      "os_name",
      "os_version",
      "os_arch",
      "cpu_variant",
      "installer",
      "shell_version",
      "installer_revision",
      "node_major",
      "installer_source_id",
      "install_method",
      "target_version",
    ],
    downloadFinished: ["schema_version", "result", "error_code", "download"],
    download: ["method", "attempt_count", "round_count", "duration_ms", "bytes"],
    installFinished: [
      "schema_version",
      "target_version",
      "result",
      "stage",
      "error_code",
      "warning_code",
      "skip_reason",
      "path_result",
      "duration_ms",
    ],
  },
  requiredFields: {
    event: ["action", "detail", "timestamp"],
    detail: ["trace_uuid", "session_id", "event_detail"],
    installStarted: [
      "schema_version",
      "os_name",
      "os_version",
      "os_arch",
      "installer",
      "shell_version",
      "installer_revision",
      "installer_source_id",
      "install_method",
    ],
    downloadFinished: ["schema_version", "result", "download"],
    download: ["method", "attempt_count", "round_count", "duration_ms"],
    installFinished: ["schema_version", "result", "duration_ms"],
  },
  optionalFields: {
    event: [],
    detail: [],
    installStarted: ["node_major", "target_version"],
    downloadFinished: ["error_code"],
    download: ["bytes"],
    installFinished: ["target_version", "stage", "error_code", "warning_code", "skip_reason", "path_result"],
  },
  installerOptionalFields: {
    bash: {
      installStarted: [],
    },
    powershell: {
      installStarted: ["cpu_variant"],
    },
  },
  interruptionErrorCodes: {
    bash: ["interrupted"],
    powershell: [],
  },
  sources: ["direct-script-v1", "gitcode-raw-v1", "deveco-self-upgrade-v1", "unknown"],
  results: ["success", "failure", "skipped"],
  installMethods: ["download", "local_binary"],
  installers: ["bash", "powershell"],
  cpuVariants: ["avx2", "baseline"],
  downloadMethods: ["curl_progress", "curl_fallback", "httpclient"],
  stages: ["preflight", "version_resolution", "download", "extract", "package_validation", "activate", "path_update"],
  errorCodes: [
    "unsupported_os",
    "unsupported_arch",
    "missing_dependency",
    "invalid_argument",
    "invalid_version",
    "release_query_failed",
    "release_not_found",
    "release_prerelease",
    "download_http_error",
    "download_empty",
    "extract_failed",
    "binary_missing",
    "version_mismatch",
    "activation_failed",
    "path_update_failed",
    "interrupted",
    "unknown",
  ],
  warningCodes: ["node_version_unsupported", "path_config_unwritable", "path_config_missing", "shell_unrecognized"],
  skipReasons: ["already_installed"],
  pathResults: ["modified", "already_present", "disabled", "warning", "failure"],
  privacy: {
    cli: ["--no-analytics", "-NoAnalytics"],
    environment: ["DEVECO_TELEMETRY_DISABLED", "DO_NOT_TRACK"],
    preferenceFile: "<state>/deveco/kv.json",
    preferenceKey: "analytics_enabled",
  },
} as const

const root = path.resolve(import.meta.dir, "../../../..")
const bash = Bun.which("bash")
const powerShellExecutables =
  process.platform === "win32"
    ? [...new Set([Bun.which("pwsh"), Bun.which("powershell.exe")].filter((item): item is string => !!item))]
    : []
const powerShell = powerShellExecutables[0]

describe("installation telemetry contract", () => {
  test("uses the existing trace upload array protocol with bounded best-effort delivery", () => {
    expect(installTelemetryContract.endpoint).toBe("https://cn.devecostudio.huawei.com/codeGenie/cli/trace/upload")
    expect(installTelemetryContract.headers.sender).toBe("deveco-installer")
    expect(installTelemetryContract.limits).toEqual({
      batchSize: 200,
      payloadBytes: 1_782_579,
      connectTimeoutSeconds: 1,
      requestTimeoutSeconds: 2,
    })
    expect(Object.values(installTelemetryContract.actions)).toEqual([
      "DevEcoCodeInstallStarted",
      "DevEcoCodeDownloadFinished",
      "DevEcoCodeInstallFinished",
    ])
  })

  test.each(["install", "install.ps1"])("keeps %s aligned with the shared contract", async (name) => {
    const script = await fs.readFile(path.join(root, name), "utf8")
    const expected =
      name === "install"
        ? [
            `TELEMETRY_MAX_EVENTS=${installTelemetryContract.limits.batchSize}`,
            `TELEMETRY_MAX_BYTES=${installTelemetryContract.limits.payloadBytes}`,
            `--connect-timeout ${installTelemetryContract.limits.connectTimeoutSeconds}`,
            `--max-time ${installTelemetryContract.limits.requestTimeoutSeconds}`,
            `Content-Type: ${installTelemetryContract.headers.contentType}`,
            `sender: $TELEMETRY_SENDER`,
            `deviceid: $TELEMETRY_DEVICE_ID`,
          ]
        : [
            `$TelemetryMaxEvents = ${installTelemetryContract.limits.batchSize}`,
            `$TelemetryMaxBytes = ${installTelemetryContract.limits.payloadBytes}`,
            `FromSeconds(${installTelemetryContract.limits.connectTimeoutSeconds})`,
            `FromSeconds(${installTelemetryContract.limits.requestTimeoutSeconds})`,
            `"sender", $TelemetrySender`,
            `"${installTelemetryContract.headers.deviceID}", $script:TelemetryInstallID`,
            `"${installTelemetryContract.headers.contentType}"`,
          ]
    const fields = [
      ...Object.values(installTelemetryContract.requiredFields).flatMap((item) => item),
      ...Object.values(installTelemetryContract.optionalFields).flatMap((item) => item),
      ...(name === "install"
        ? installTelemetryContract.installerOptionalFields.bash.installStarted
        : installTelemetryContract.installerOptionalFields.powershell.installStarted),
    ]

    expect(script).toContain(installTelemetryContract.endpoint)
    expect(script).toContain(installTelemetryContract.headers.sender)
    expect(script).toContain(installTelemetryContract.installerRevision)
    for (const value of expected) expect(script).toContain(value)
    for (const field of new Set(fields)) expect(script).toContain(field)
    for (const action of Object.values(installTelemetryContract.actions)) expect(script).toContain(action)
    for (const source of installTelemetryContract.sources) expect(script).toContain(source)
    expect(script).not.toMatch(/["']Authorization["']|["']Cookie["']/)
  })

  test("models every schema field as required, common optional, or installer-specific", () => {
    expect(
      new Set([
        ...installTelemetryContract.requiredFields.installStarted,
        ...installTelemetryContract.optionalFields.installStarted,
        ...installTelemetryContract.installerOptionalFields.bash.installStarted,
        ...installTelemetryContract.installerOptionalFields.powershell.installStarted,
      ]),
    ).toEqual(new Set(installTelemetryContract.fields.installStarted))
    for (const name of ["event", "detail", "downloadFinished", "download", "installFinished"] as const) {
      expect(
        new Set([...installTelemetryContract.requiredFields[name], ...installTelemetryContract.optionalFields[name]]),
      ).toEqual(new Set(installTelemetryContract.fields[name]))
    }
    expect(installTelemetryContract.interruptionErrorCodes.bash).toEqual(["interrupted"])
    expect(installTelemetryContract.interruptionErrorCodes.powershell).toEqual([])
  })

  test("serializes one batched array and exposes all privacy controls", async () => {
    const bash = await fs.readFile(path.join(root, "install"), "utf8")
    const powershell = await fs.readFile(path.join(root, "install.ps1"), "utf8")

    expect(bash).toContain('local payload="[$TELEMETRY_EVENTS]"')
    expect(powershell).toContain("ConvertTo-Json -InputObject @($script:TelemetryEvents)")
    for (const value of ["DEVECO_TELEMETRY_DISABLED", "DO_NOT_TRACK", "analytics_enabled"]) {
      expect(bash).toContain(value)
      expect(powershell).toContain(value)
    }
    expect(bash).toContain("--no-analytics")
    expect(powershell).toContain("NoAnalytics")
    expect(bash).toContain(installTelemetryContract.testEndpointEnvironment)
    expect(powershell).toContain(installTelemetryContract.testEndpointEnvironment)
    expect(bash).toContain("TELEMETRY_MAX_EVENTS=200")
    expect(bash).toContain("TELEMETRY_MAX_BYTES=1782579")
    expect(bash).toContain("wc -c")
    expect(bash).not.toContain("${#payload}")
    expect(bash).toMatch(/\r?\ntelemetry_init\r?\n/)
    expect(bash).not.toContain("telemetry_init ||")
    expect(powershell).toContain("$TelemetryMaxEvents = 200")
    expect(powershell).toContain("$TelemetryMaxBytes = 1782579")
    expect(bash).toContain('TELEMETRY_DOWNLOAD_METHOD="curl_progress"')
    expect(bash).toContain('TELEMETRY_DOWNLOAD_METHOD="curl_fallback"')
    expect(powershell).toContain('method = "httpclient"')
    expect(installTelemetryContract.errorCodes).not.toContain("asset_not_found")
  })

  test.skipIf(!bash)("rejects non-loopback endpoint overrides in the Bash selector", async () => {
    const script = await fs.readFile(path.join(root, "install"), "utf8")
    const selector = script.slice(script.indexOf("telemetry_endpoint() {"), script.indexOf("telemetry_add_event() {"))
    const proc = Bun.spawn([bash!, "-c", `${selector}\ntelemetry_endpoint`], {
      env: {
        ...process.env,
        TELEMETRY_ENDPOINT: installTelemetryContract.endpoint,
        DEVECO_INSTALLER_TELEMETRY_ENDPOINT: "https://example.com/trace",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toBe(installTelemetryContract.endpoint)
  })

  test.each(powerShellExecutables)("rejects non-loopback endpoint overrides with %s", async (executable) => {
    const script = await fs.readFile(path.join(root, "install.ps1"), "utf8")
    const selector = script.slice(
      script.indexOf("function Get-InstallTelemetryEndpoint"),
      script.indexOf("function Add-InstallTelemetryEvent"),
    )
    const proc = Bun.spawn(
      [
        executable,
        "-NoProfile",
        "-Command",
        `$TelemetryEndpoint = '${installTelemetryContract.endpoint}'\n${selector}\nGet-InstallTelemetryEndpoint`,
      ],
      {
        env: {
          ...process.env,
          DEVECO_INSTALLER_TELEMETRY_ENDPOINT: "https://example.com/trace",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout.trim()).toBe(installTelemetryContract.endpoint)
  })

  test.skipIf(process.platform !== "darwin" || !bash)("all Bash opt-outs suppress delivery", async () => {
    await Promise.all(
      [
        { name: "flag", args: ["--no-analytics"], env: {}, preference: undefined },
        { name: "disabled environment", args: [], env: { DEVECO_TELEMETRY_DISABLED: "1" }, preference: undefined },
        { name: "do not track", args: [], env: { DO_NOT_TRACK: "1" }, preference: undefined },
        { name: "preference", args: [], env: {}, preference: { analytics_enabled: false } },
      ].map(async (control) => {
        await using tmp = await tmpdir()
        const state = path.join(tmp.path, "state")
        if (control.preference) {
          await fs.mkdir(path.join(state, "deveco"), { recursive: true })
          await Bun.write(path.join(state, "deveco", "kv.json"), JSON.stringify(control.preference))
        }
        let requests = 0
        const server = Bun.serve({
          port: 0,
          fetch() {
            requests++
            return new Response(null, { status: 204 })
          },
        })
        try {
          const proc = Bun.spawn(
            [bash!, path.join(root, "install"), "--binary", path.join(tmp.path, "missing"), ...control.args],
            {
              env: {
                ...process.env,
                DEVECO_TELEMETRY_DISABLED: "",
                DO_NOT_TRACK: "",
                DEVECO_INSTALLER_TELEMETRY_ENDPOINT: `http://127.0.0.1:${server.port}/trace`,
                HOME: tmp.path,
                XDG_DATA_HOME: path.join(tmp.path, "data"),
                XDG_STATE_HOME: state,
                SHELL: "/bin/zsh",
                ...control.env,
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const [stderr, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited])
          expect(exitCode, `${control.name}: ${stderr}`).toBe(1)
          expect(requests, control.name).toBe(0)
        } finally {
          server.stop(true)
        }
      }),
    )
  })

  test.skipIf(!powerShell)("all PowerShell opt-outs suppress delivery", async () => {
    await Promise.all(
      [
        { name: "flag", args: ["-NoAnalytics"], env: {}, preference: undefined },
        { name: "disabled environment", args: [], env: { DEVECO_TELEMETRY_DISABLED: "1" }, preference: undefined },
        { name: "do not track", args: [], env: { DO_NOT_TRACK: "1" }, preference: undefined },
        { name: "preference", args: [], env: {}, preference: { analytics_enabled: false } },
      ].map(async (control) => {
        await using tmp = await tmpdir()
        const state = path.join(tmp.path, "state")
        if (control.preference) {
          await fs.mkdir(path.join(state, "deveco"), { recursive: true })
          await Bun.write(path.join(state, "deveco", "kv.json"), JSON.stringify(control.preference))
        }
        let requests = 0
        const server = Bun.serve({
          port: 0,
          fetch() {
            requests++
            return new Response(null, { status: 204 })
          },
        })
        try {
          const proc = Bun.spawn(
            [
              powerShell!,
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              path.join(root, "install.ps1"),
              "-Binary",
              path.join(tmp.path, "missing.exe"),
              ...control.args,
            ],
            {
              env: {
                ...process.env,
                DEVECO_TELEMETRY_DISABLED: "",
                DO_NOT_TRACK: "",
                DEVECO_INSTALLER_TELEMETRY_ENDPOINT: `http://127.0.0.1:${server.port}/trace`,
                USERPROFILE: path.join(tmp.path, "profile"),
                XDG_DATA_HOME: path.join(tmp.path, "data"),
                XDG_STATE_HOME: state,
                ...control.env,
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const [stderr, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited])
          expect(exitCode, `${control.name}: ${stderr}`).toBe(1)
          expect(requests, control.name).toBe(0)
        } finally {
          server.stop(true)
        }
      }),
    )
  })

  test("marks script-based self upgrades without changing package-manager upgrades", async () => {
    const source = await fs.readFile(path.join(root, "packages/opencode/src/installation/index.ts"), "utf8")

    expect(source.match(/DEVECO_INSTALL_SOURCE: "deveco-self-upgrade-v1"/g)).toHaveLength(2)
  })

  test.skipIf(process.platform !== "darwin" || !bash)(
    "uploads one array for a local macOS install",
    async () => {
      await using tmp = await tmpdir()
      const binary = path.join(tmp.path, "artifact", "bin", "deveco")
      await fs.mkdir(path.dirname(binary), { recursive: true })
      await Bun.write(binary, '#!/bin/sh\n[ "$1" = "--version" ] && echo telemetry-test\n')
      await fs.chmod(binary, 0o755)

      let received: Request | undefined
      let payload: unknown
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          received = request
          payload = await request.json()
          return new Response(null, { status: 204 })
        },
      })
      try {
        const proc = Bun.spawn(
          [
            bash!,
            path.join(root, "install"),
            "--binary",
            binary,
            "--no-modify-path",
            "--install-source",
            "direct-script-v1",
          ],
          {
            env: {
              ...process.env,
              DEVECO_TELEMETRY_DISABLED: "",
              DO_NOT_TRACK: "",
              DEVECO_INSTALLER_TELEMETRY_ENDPOINT: `http://127.0.0.1:${server.port}/trace`,
              HOME: tmp.path,
              XDG_DATA_HOME: path.join(tmp.path, "data"),
              XDG_STATE_HOME: path.join(tmp.path, "state"),
              SHELL: "/bin/zsh",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [stdout, stderr, exitCode] = await Promise.all([
          Bun.readableStreamToText(proc.stdout),
          Bun.readableStreamToText(proc.stderr),
          proc.exited,
        ])
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
        expect(received?.headers.get("sender")).toBe(installTelemetryContract.headers.sender)
        expect(received?.headers.get("authorization")).toBeNull()
        expect((payload as Array<{ action: string }>).map((event) => event.action)).toEqual([
          installTelemetryContract.actions.installStarted,
          installTelemetryContract.actions.installFinished,
        ])
      } finally {
        server.stop(true)
      }
    },
    15_000,
  )

  test.each(powerShellExecutables)(
    "uploads one array for a local PowerShell install with %s",
    async (powerShell) => {
      await using tmp = await tmpdir()
      const binary = path.join(tmp.path, "artifact", "bin", "deveco.exe")
      const profile = path.join(tmp.path, "profile")
      const data = path.join(tmp.path, "data")
      await fs.mkdir(path.dirname(binary), { recursive: true })
      await fs.copyFile(process.execPath, binary)

      let received: Request | undefined
      let payload: unknown
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          received = request
          payload = await request.json()
          return new Response(null, { status: 204 })
        },
      })
      try {
        const proc = Bun.spawn(
          [
            powerShell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(root, "install.ps1"),
            "-Binary",
            binary,
            "-NoModifyPath",
            "-InstallSource",
            "direct-script-v1",
          ],
          {
            env: {
              ...process.env,
              DEVECO_TELEMETRY_DISABLED: "",
              DO_NOT_TRACK: "",
              DEVECO_INSTALLER_TELEMETRY_ENDPOINT: `http://127.0.0.1:${server.port}/trace`,
              USERPROFILE: profile,
              XDG_DATA_HOME: data,
              XDG_STATE_HOME: path.join(tmp.path, "state"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [stdout, stderr, exitCode] = await Promise.all([
          Bun.readableStreamToText(proc.stdout),
          Bun.readableStreamToText(proc.stderr),
          proc.exited,
        ])
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
        expect(
          received,
          `${stdout}\n${stderr}\ninstall-id=${await fs
            .stat(path.join(data, "deveco", "analytics", "installer-install-id"))
            .then(
              () => "present",
              () => "missing",
            )}`,
        ).toBeDefined()
        expect(received?.headers.get("sender")).toBe(installTelemetryContract.headers.sender)
        expect(received?.headers.get("deviceid")).toMatch(/^[0-9a-f]{32}$/i)
        const persistedID = (
          await fs.readFile(path.join(data, "deveco", "analytics", "installer-install-id"), "utf8")
        ).trim()
        expect(persistedID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
        expect(received?.headers.get("deviceid")).toBe(persistedID.replaceAll("-", ""))
        expect(received?.headers.get("authorization")).toBeNull()
        expect(received?.headers.get("cookie")).toBeNull()
        expect(Array.isArray(payload)).toBe(true)
        expect((payload as Array<{ action: string }>).map((event) => event.action)).toEqual([
          installTelemetryContract.actions.installStarted,
          installTelemetryContract.actions.installFinished,
        ])
        for (const event of payload as Array<Record<string, unknown>>) {
          expect(Object.keys(event).sort()).toEqual([...installTelemetryContract.fields.event].sort())
        }
        const details = (payload as Array<{ detail: string }>).map((event) => JSON.parse(event.detail))
        for (const detail of details) {
          expect(Object.keys(detail).sort()).toEqual([...installTelemetryContract.fields.detail].sort())
        }
        expect(details[0].session_id).toBe(details[1].session_id)
        expect(details[0].trace_uuid).not.toBe(details[1].trace_uuid)
        expect(details[0].event_detail.install_method).toBe("local_binary")
        expect(details[0].event_detail.target_version).toBeUndefined()
        expect(details[1].event_detail.result).toBe("success")
        expect(details[1].event_detail.target_version).toBe(Bun.version)
        expect(details[1].event_detail.path_result).toBe("disabled")
        expect(JSON.stringify(payload)).not.toContain('"uid"')
        expect(JSON.stringify(payload)).not.toContain("OperationNonce")
      } finally {
        server.stop(true)
      }
    },
    15_000,
  )
})
