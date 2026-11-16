# analytics plugin — event field rules

Scope: the classic telemetry stream under `src/plugin/analytics` (actions committed through
`ANALYTICS_ACTION`). The Magpie stream under `src/plugin/analytics-magpie` has its own schema
(`analyticsSchemaVersion: 2`, `MAGPIE_ANALYTICS_STORAGE_SCHEMA_VERSION`) and follows different
rules; do not copy these wholesale into it.

Read this before adding an analytics action, adding a field to an existing event, or changing a
validator in `storage.ts`.

## Event anatomy

Every classic event is a flat JSON object; `AnalyticsEnvironmentFields` is the common base.
The queue stores `{ action, event, uid, queueId, sealed }`; the uploader sends
`{ action, detail: JSON.stringify(event), timestamp: uploadTime }`.

| action | event interface | env5 | timestamp | sessionid | projectId |
| --- | --- | --- | --- | --- | --- |
| `DevEcoCodeSession` | `AiSessionEvent` | yes | no (wire upload time only) | yes | yes |
| `DevEcoCodeSlash` | `DevEcoCodeSlashEvent` | yes | yes | yes | yes |
| `DevEcoCodeAttribution` | `DevEcoCodeAttributionEvent` | yes | yes | yes | yes |
| `DevEcoCodeBuild` | `BuildProjectAnalyticsEvent` | yes | no | yes | no |
| UI verification | `UiVerificationAnalyticsEvent` | yes | no | yes | no |

`env5` = `sourceType`, `sourceVersion`, `os_arch`, `os_name`, `os_version`.

Only `env5` is required on every event; the remaining columns record event-specific details of
existing events.

## Rules

1. **Never hand-write the environment fields.** Build them with
   `createEnvironmentFields(dependencies.version())` from `src/plugin/analytics/events.ts`.
   `sourceType` comes from `Runtime.getAnalyticsSource()`
   (`packages/core/src/runtime.ts`), so a literal `"DevEco-Code-Cli"` in a new call site will
   eventually be wrong for the IDE plugin surface.
2. **One event, one exact key set.** The validator in `storage.ts` uses
   `hasExactKeys` + `Object.hasOwn` conditional keys, and `preparePendingBatch` drops anything
   the validator rejects. When you add a field, add it to: the interface, the emitter, the exact
   key list, the tests' key-set assertion, and the wire sample in the PR.
3. **Keep older queued shapes readable.** A user upgrading the CLI must not lose the events the
   previous build already queued. When the shape changes, teach the validator both shapes (see
   `isAiCodeAttributionEvent`, which accepts the legacy 5-key totals and the current 12-key
   event) rather than tightening it. Compatibility is one-directional: an old build reading a new
   event will drop it, so say so in the PR body.
4. **Do not bump `ANALYTICS_SCHEMA_VERSION` casually.** `storage.ts` compares the version on
   read and discards the whole pending queue on mismatch (see `ANALYTICS_SCHEMA_VERSION = 13`).
   A bump is a deliberate data-loss decision that needs an explicit reason, not part of adding a
   field.
5. **Keep the wire payload free of local-only data**: no absolute paths, no prompt text, no
   hardware identifiers, no tokens. Bounded previews only (see `BuildProjectInfo.output`), and
   `deviceId` stays the install-level id — never the MAC-derived `deviceid` header value.

## Checklist for a new field or a new event

- [ ] Interface declared in `types.ts`, extending `AnalyticsEnvironmentFields` for new events.
- [ ] Emitter fills env via `createEnvironmentFields(version())`; `projectId` present when the
      event is project-scoped.
- [ ] Validator in `storage.ts`: exact key set, per-field guard (`isLineCount`,
      `isSlashCommandTimestamp`, `isAnalyticsSourceType`, `hasStrings`, ...), legacy shape kept.
- [ ] No `ANALYTICS_SCHEMA_VERSION` bump unless the PR explains why losing the queue is fine.
- [ ] Tests: emitted event pinned with `toHaveBeenCalledWith` (full object), queue round-trip and
      rejection cases routed through `preparePendingBatch` (the uploader's real read path), not
      only `getPendingEvents` — the latter does not filter.
- [ ] `cd packages/opencode && bun test --isolate --timeout 60000 test/plugin/analytics`,
      `bun run typecheck`, and `bunx oxlint packages/opencode/src/plugin/analytics` stay green.

## Known failure modes

- Adding a key to the interface and the emitter but not to the validator: the new events are
  silently dropped at upload time, and only the tsgo build in a test that reads the queue notices.
- Adding a key to the validator but not accepting the old shape: every event already queued by
  the previous build disappears on the next read.
- Reusing a name that already means something else in the wire format (`timestamp`, `sourceType`,
  `sessionid`): the platform column mapping is per action and per key, so a new meaning under an
  old name is a silent data corruption.
