# AGENTS.md

IntelliJ Platform plugin (Kotlin/JVM) that embeds OpenCode via the Agent Client Protocol (ACP). Not an ArkTS/HarmonyOS project, despite the surrounding DevEco tooling environment.

## Build & run

- Build: `./gradlew build` (Windows: `gradlew.bat`). Gradle config cache + build cache are enabled in `gradle.properties`.
- Run IDE with plugin loaded: `./gradlew runIde` (sandbox under `s/`, see below).
- Run tests / full check: `./gradlew check` (JUnit 4 tests under `src/test`; a fresh worktree needs `bun install` at the repo root first, see Conventions).
- Verify plugin compatibility: `./gradlew verifyPlugin`.
- Predefined IntelliJ Run/Debug configs live in `.run/` (`runIde`, `runTests` → `:check`, `runVerifications` → `:verifyPlugin`).

## Toolchain quirks (easy to get wrong)

- **Sandbox paths are intentionally short** (`sandboxContainer = "s"`, `projectName = "p"`) to stay within the Windows AF_UNIX socket 108-character path limit. Do not lengthen them.
- **Kotlin stdlib is NOT bundled** (`kotlin.stdlib.default.dependency=false` in `gradle.properties`). The `acp-jvm` dependency excludes `kotlin-stdlib` and `kotlinx-coroutines-core-jvm` to avoid class-loader conflicts on plugin reload — preserve these excludes when updating.
- **Repositories**: Huawei Cloud mirror (`https://repo.huaweicloud.com/repository/maven/`) is primary, `mavenCentral()` and IntelliJ `defaultRepositories()` are fallbacks. Configured in `settings.gradle.kts`.
- UI is built with Compose via Jewel (`addComposeTab`). Bundled Jewel markdown modules are declared as `<dependencies>` in `plugin.xml` and as `bundledModule(...)` in `build.gradle.kts` — keep both in sync.
- Requires the `com.intellij.modules.compose` module, so the plugin only runs on Compose-capable IDE builds.

## Architecture

- Plugin ID: `org.deveco.code.deveco-code-jetbrains-plugin`; name "DevEco Code". Config in `src/main/resources/META-INF/plugin.xml`.
- `SharedAcpBackend` (app-level `@Service`) owns the single `deveco acp --hostname 127.0.0.1 --port <port>` subprocess shared by all open projects: it spawns/kills the process (spawned on first project attach, killed when the last attachment is disposed), holds the HTTP sidecar port/`DevEcoHttpApi`, and demultiplexes session updates / permission prompts to the owning project's facade by session id. The ACP wire itself runs over the child's stdio; `--port` only configures the backend's HTTP sidecar. The process is spawned in the plugin's deveco storage root — never a project directory: on Windows a process's cwd locks that directory against deletion. Lifecycle is expressed in the Disposer tree: each spawned `AcpClientConnection` is registered as a child of the backend, and each project's claim is an `Attachment` handle the facade registers under itself (project disposal detaches; the last one out stops the process). Disposer registration/disposal never happens under the backend's monitor — dispose callbacks run under the Disposer tree lock and re-enter that monitor, so mixing the two lock orders can deadlock.
- `AcpClientService` (project-level `@Service`) is the per-project facade over `SharedAcpBackend`: it keeps per-project listeners, permission handlers, `SessionStatusTracker`, the IDE MCP endpoint and the project cwd (sent per `session/new`/`session/load` and as `?directory=` on every HTTP call), and delegates connection ops to the shared backend. Consumers never talk to the backend directly. The service doubles as a Disposer anchor: the `IdeMcpSession` and the backend `Attachment` are registered as its children, so project disposal detaches and stops the MCP endpoint structurally — its `dispose()` body is intentionally empty.
- `DevEcoToolWindowFactory` registers a "DevEco Code" tool window with a Compose "Sessions" tab.
- Background subagent status stream: `SharedAcpBackend` also owns one SSE reader on the sidecar's `/global/event` (10s heartbeats; a watchdog closes a stale stream, reconnect backs off exponentially). The reader thread only parses — events, resyncs, and the routing state they mutate (child→parent edges, busy/settled/deferred children in `AcpClientService`) run on one ordered worker (`postStatusTask`), preserving stream order without blocking the reader, which would starve the watchdog into reconnect loops. The resync probe and per-child final-state reads are HTTP and run on pooled threads, posting results back to the worker. `session.status` drives the sidebar/composer running state (`SessionStatusTracker.extraRunningIds` / `serverTurn`) and live-settles background task cards, whose completion notices the backend only replays.
- Package layout under `src/main/kotlin/org/deveco/code/`:
  - `acp/` — ACP wire types, `SharedAcpBackend` (app-level owner of the shared subprocess), `AcpClientConnection` (subprocess + stdio bridge, cwd passed per session), `AcpClientService` (per-project facade), `AcpToolInputParser`.
  - `action/` — `NewSessionAction`, `DevEcoSessionActions`.
  - `session/` — `SessionController`, stores (`SessionModelStore`, `SessionStorage`, `SessionViewStateStore`, `TokenUsageStore`, `SessionRefreshTopic`), `Thumbnailer`, plus subpackages:
    - `model/` — `ChatModels`, `SessionViewState`, `ToolFileLocation`.
    - `editor/` — `SessionFileEditor`, `SessionFileEditorProvider`, `SessionVirtualFile`, `SessionEditorPreview`.
    - `ui/` — `SessionScreen`, `SessionMessageItem` (dispatcher); `messages/` (per-role item renderers: Agent/System/Thought/Tool/UserMessageItem); `composer/` (`SessionComposer` + sub-components: selectors, popups, attachments, image viewer).
  - `sessions/` — `DevEcoSessions` (sessions-list panel) and `ui/` — `SessionsScreen`, `SessionCard`, `SessionContextMenu`, `SidebarNav` (session list).
  - `settings/` — `AICodingConfigurable`, `ArchivedSessionsConfigurable`, `SkillSettingsConfigurable`.
  - `sidebar/` — `SessionStatusTracker` (running/abnormal session tracking).
  - `skill/` — `SkillStore`, `SkillEntry`.
  - `toolwindow/` — tool window factory.
  - `util/` — `ModifierExtensions` (`Modifier.hoverable`), `ProjectExtensions` (`opencodeConfigDir`, `runInEdt`, `errorMessage`).
  - Root package holds only the widely-used singletons `DevEcoTheme` and `MyMessageBundle`.

## Runtime / environment

- The plugin runs only the CLI bundled in the plugin jar (extracted to `<system>/@deveco`, keyed by plugin version); if the bundled binary is unavailable, `AcpClientService.connect()` returns `false` with a FAILED status. There are no PATH or env-var fallbacks.
- Every `SharedAcpBackend` connection generates fresh per-process HTTP basic-auth credentials (`SecureRandom`: `deveco_<random>` username + 256-bit random password) and hands them to the `deveco acp` subprocess via env vars `DEVECO_SERVER_USERNAME`/`DEVECO_SERVER_PASSWORD`; the backend then enforces basic auth on every route. All plugin HTTP calls (incl. `deleteSession`, which uses the HTTP API directly) send this Authorization header. The HTTP endpoint is loopback-only: `--hostname` is hardcoded to `127.0.0.1`.
- `runIde` logs land in `.intellijPlatform/sandbox/*/*/log/idea.log` (see `.run/*.xml`).

## Conventions

- Source is Kotlin only (no `src/main/java`). Package root `org.deveco.code`.
- Version catalog: `gradle/libs.versions.toml`. Add external deps there, reference as `libs.<alias>`.
- Formatting: Spotless (ktlint 1.8.0 + eclipse-wtp XML) is wired into `check`; run `./gradlew spotlessApply` before committing.
- Lifecycle: stateful objects implement `Disposable` and are registered with `Disposer.register(parent, child)` under their owning service (`AcpClientService` for project scope, `SharedAcpBackend` for app scope) instead of being disposed by hand — teardown then follows the Disposer tree down from Project/Application. `AcpClientConnection.dispose()` is idempotent because both direct teardown (connection replaced/retired) and the tree can reach the same object.
- Tests live in `src/test/kotlin` (JUnit 4); `./gradlew check` runs them plus Spotless. No CI.
- `build` depends on `bundleLocalCli`, which rebuilds the deveco CLI from `packages/opencode` with bun; a fresh worktree needs `bun install` at the repo root first.
