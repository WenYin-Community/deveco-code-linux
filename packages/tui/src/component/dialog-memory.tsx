import { For, createEffect, createMemo, createResource, createSignal, Show } from "solid-js"
import path from "node:path"
import { TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useProject } from "../context/project"
import { useTuiPaths } from "../context/runtime"
import { useToast } from "../ui/toast"
import { useClipboard } from "../context/clipboard"
import { Selection } from "../util/selection"
import { useBindings, formatKeyBindings, useKeymapSelector } from "../keymap"
import { useTuiConfig } from "../config"
import { useI18n } from "../i18n"
import { DialogConfirm } from "../ui/dialog-confirm"
import { Locale } from "../util/locale"
import { Memory } from "../util/memory"

const SETTING = "setting:"
const ITEM = "memory:"

// DialogConfirm replaces the dialog view it was opened from, so both the cancel and the
// success path have to re-open something.
async function confirmDelete(
  deps: { dialog: DialogContext; toast: ReturnType<typeof useToast>; title: string; message: string; success: string },
  task: () => Promise<unknown>,
  done: () => void,
  cancel = done,
) {
  if ((await DialogConfirm.show(deps.dialog, deps.title, deps.message)) !== true) return cancel()
  try {
    await task()
    deps.toast.show({ message: deps.success, variant: "success" })
  } catch (error) {
    deps.toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" })
  }
  return done()
}

/** `current` is the option value to put the cursor on, used to come back from a memory view. */
export function showMemory(dialog: DialogContext, current?: string) {
  dialog.replace(() => <DialogMemory current={current} />)
}

/** The same data/config/directory the plugin's paths resolve against. */
function useMemoryScope() {
  const project = useProject()
  const paths = useTuiPaths()
  return createMemo(() => ({
    data: project.instance.path().data || paths.data,
    config: project.instance.path().config || paths.config,
    directory: project.instance.path().directory || paths.cwd,
  }))
}

function State(props: { enabled: boolean }) {
  const { theme } = useTheme()
  const { t } = useI18n()
  if (!props.enabled) return <span style={{ fg: theme.textMuted }}>{t("dialog.memory_disabled")}</span>
  return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>{t("dialog.memory_enabled")}</span>
}

export function DialogMemory(props: { current?: string }) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  // Where the pointer is, for the action hints: a setting row offers toggle, a memory row offers view
  // and delete. Not wired back into DialogSelect's `current`, which would re-center the list on hover.
  const [current, setCurrent] = createSignal<string | undefined>()

  dialog.setSize("large")

  const scope = useMemoryScope()

  const [snapshot, { refetch }] = createResource(scope, async (scope) => {
    const config = await Memory.readConfig(scope)
    const dir = Memory.memoryDir(config, scope)
    const [memories, pendingExpiry] = await Promise.all([Memory.list(dir), Memory.readPendingExpiryNames(dir)])
    return { config, dir, memories, pendingExpiry }
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const data = snapshot()
    if (!data) return []
    return [
      ...Memory.SETTINGS.map((setting) => ({
        value: SETTING + setting.key,
        title: t(`dialog.memory_setting.${setting.id}`),
        footer: <State enabled={Memory.isEnabled(data.config, setting)} />,
        category: t("category.memory_settings"),
      })),
      ...(data.memories.length === 0
        ? [
            {
              value: "empty:" + data.dir,
              title: t("dialog.memory_empty"),
              description: data.dir,
              category: t("category.memory_items"),
            },
          ]
        : data.memories.map((memory) => {
            const expired = data.pendingExpiry.has(memory.name)
            const suffix = expired ? `（${t("dialog.memory_expired")}）` : ""
            const date = Locale.datetime(memory.mtime)
            const footer = `${date.padStart(19)}${memory.type.padStart(9)}`
            // Row: [padLeft:3] [title flexGrow, overflow:hidden] [gap:1] [footer flexShrink] [padRight:3]
            // Title text has paddingLeft:3 internally, reducing its content area by 3.
            const dialogWidth = Math.min(88, dimensions().width)
            const available = dialogWidth - 3 - 3 - 1 - 3 - 3 - footer.length
            const titleLen = memory.name.length + suffix.length
            const title =
              titleLen > available
                ? Locale.truncateMiddle(memory.name, Math.max(4, available - suffix.length)) + suffix
                : memory.name + suffix
            return {
              value: ITEM + memory.file,
              title,
              truncateTitle: false,
              footer,
              category: t("category.memory_items"),
            }
          })),
    ]
  })

  async function toggle(option: DialogSelectOption<string>) {
    const setting = Memory.SETTINGS.find((item) => SETTING + item.key === option.value)
    if (!setting || busy()) return
    setBusy(true)
    try {
      await Memory.writeSetting(scope(), setting, !Memory.isEnabled(snapshot()?.config ?? {}, setting))
      await refetch()
    } catch (error) {
      toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  function open(option: DialogSelectOption<string>) {
    if (!option.value.startsWith(ITEM)) return
    showDetail(dialog, option.value.slice(ITEM.length))
  }

  function removeMemory(file: string, name: string) {
    return confirmDelete(
      {
        dialog,
        toast,
        title: t("dialog.memory_delete_title", { name }),
        message: t("dialog.memory_delete_message"),
        success: t("toast.memory_deleted"),
      },
      () => Memory.remove(file, snapshot()?.config ?? {}),
      // The list reloads its snapshot on mount, so re-opening it is also the refresh. A deleted
      // row has nothing to restore the cursor onto, a cancelled one does.
      () => showMemory(dialog),
      () => showMemory(dialog, ITEM + file),
    )
  }

  const active = createMemo(() => current() ?? options()[0]?.value ?? "")

  // The rows come off disk, so the restored row can only be resolved once they exist, and it is a
  // one-shot move. DialogSelect's `current` is not a live cursor: every change to it re-centers the
  // list, which slides rows under a still pointer, which the renderer reports back as a new hover,
  // which would move `current` again. Hover therefore only drives the hints here.
  let select: DialogSelectRef<string> | undefined
  let restored = false
  createEffect(() => {
    if (restored || !props.current || !options().length) return
    restored = true
    setCurrent(props.current)
    select?.moveTo(props.current)
  })

  return (
    <DialogSelect
      ref={(value) => {
        select = value
      }}
      title={t("dialog.title_memory")}
      options={options()}
      current={props.current}
      showCurrentMarker={false}
      onMove={(option) => setCurrent(option.value)}
      // The note is about config changes, and the footer row is narrow: on a memory row the
      // action hints need that space instead.
      footerHints={
        active().startsWith(SETTING) ? [{ title: t("dialog.memory_config_note"), label: "", side: "right" }] : []
      }
      actions={[
        {
          command: "dialog.memory.toggle",
          title: t("dialog.action_toggle"),
          // hidden instead of disabled so the footer only offers what the row can do.
          hidden: !active().startsWith(SETTING),
          onTrigger: toggle,
        },
        {
          command: "dialog.memory.view",
          title: t("dialog.action_view_detail"),
          hidden: !active().startsWith(ITEM),
          onTrigger: open,
        },
        {
          command: "dialog.memory.delete",
          title: t("dialog.action_delete"),
          hidden: !active().startsWith(ITEM),
          onTrigger: (option) => removeMemory(option.value.slice(ITEM.length), option.title),
        },
      ]}
      onSelect={(option) => (option.value.startsWith(SETTING) ? toggle(option) : open(option))}
    />
  )
}

function showDetail(dialog: DialogContext, file: string) {
  dialog.replace(() => <MemoryDetail file={file} />)
  // replace() resets the geometry, so re-apply the list size to keep both views the same.
  dialog.setSize("large")
}

// The renderer dereferences its mouse-capture target after the mouse-up handler returns, so a
// click that replaces this very view has to wait for the event to finish.
function afterEvent(fn: () => void) {
  return () => setTimeout(fn, 0)
}

function MemoryDetail(props: { file: string }) {
  const { theme, syntax } = useTheme()
  const { t } = useI18n()
  const dialog = useDialog()
  const renderer = useRenderer()
  const toast = useToast()
  const clipboard = useClipboard()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const scope = useMemoryScope()
  const [item] = createResource(() => Memory.readItem(props.file))
  const [pendingExpiry] = createResource(() => Memory.readPendingExpiryNames(path.dirname(props.file)))
  const expired = createMemo(() => {
    const detail = item()
    return !!detail?.header?.name && pendingExpiry()?.has(detail.header.name) === true
  })
  // The plugin, dream cleanup or another window can delete the file between the list snapshot and
  // this read, so "gone" and "unreadable" are states to render, not crashes. Everything else in
  // the panel stays put so both cases keep the same shape as the list.
  const failure = createMemo(() => {
    const error = item.error
    if (!error) return undefined
    return error instanceof Error ? error.message : String(error)
  })
  const unavailable = createMemo(() => !item.loading && !item())
  // Same source DialogSelect uses for its footer hints, so a rebound key shows its real binding.
  const actionBindings = useKeymapSelector((keymap) =>
    keymap.getCommandBindings({
      visibility: "registered",
      commands: ["dialog.memory.delete"],
    }),
  )
  const deleteHint = createMemo(() => formatKeyBindings(actionBindings().get("dialog.memory.delete"), tuiConfig))

  useBindings(() => ({
    commands: [
      {
        name: "dialog.memory.delete",
        title: t("dialog.action_delete"),
        category: t("category.memory"),
        run: remove,
      },
    ],
    bindings: [
      ...tuiConfig.keybinds.get("dialog.memory.delete"),
      {
        key: "escape",
        desc: t("dialog.close_dialog"),
        group: t("category.dialog"),
        cmd: back,
      },
      {
        key: "return",
        desc: t("dialog.close_dialog"),
        group: t("category.dialog"),
        cmd: back,
      },
    ],
  }))

  // DialogConfirm replaces this view, so cancel goes back to the content and success to the list.
  function remove() {
    // Nothing left to delete: go back and let the list re-read the directory.
    if (unavailable()) return back()
    const name = item()?.header?.name ?? path.basename(props.file, ".md")
    return confirmDelete(
      {
        dialog,
        toast,
        title: t("dialog.memory_delete_title", { name }),
        message: t("dialog.memory_delete_message"),
        success: t("toast.memory_deleted"),
      },
      async () => Memory.remove(props.file, await Memory.readConfig(scope())),
      () => showMemory(dialog),
      () => showDetail(dialog, props.file),
    )
  }

  // Clicking the content goes back to the list, same as escape. A memory that is gone has no row
  // left to put the cursor back on, so it lands on the settings instead.
  function back() {
    showMemory(dialog, unavailable() ? undefined : ITEM + props.file)
  }

  // The file's own frontmatter is the metadata block; name is already the heading. created and
  // updated are epoch ms, and both get the date shown because the pair has to stay comparable.
  const meta = createMemo(() => {
    const detail = item()
    const header = detail?.header
    const rows: { key: string; value: string }[] = header
      ? [
          { key: "description", value: String(header.description) },
          { key: "type", value: String(header.type) },
          ...(header.created ? [{ key: "created", value: showStamp("created", String(header.created)) }] : []),
          ...(header.updated ? [{ key: "updated", value: showStamp("updated", String(header.updated)) }] : []),
          ...(header.pin ? [{ key: "pin", value: String(header.pin) }] : []),
          ...(header.ttl !== undefined ? [{ key: "ttl", value: String(header.ttl) }] : []),
        ]
      : []
    const filtered = rows.filter((row) => row.key !== "name" && row.value !== "")
    // A memory written before the plugin stamped files only has the mtime left.
    if (!header?.created && !header?.updated && detail?.mtime) {
      filtered.push({ key: "time", value: Locale.datetime(detail.mtime) })
    }
    const width = filtered.reduce((max, row) => Math.max(max, row.key.length), 0) + 1
    return filtered.map((row) => ({ ...row, key: row.key.padEnd(width) }))
  })

  function showStamp(key: string, value: string) {
    if (key !== "created" && key !== "updated") return value
    const stamp = Number(value)
    return Number.isFinite(stamp) && stamp > 0 ? Locale.datetime(stamp) : value
  }

  // Stable height: deriving it from the content makes the panel grow while the file loads.
  // Matches the list scrollbox cap in dialog-select so both views look identical.
  const height = createMemo(() => Math.max(6, Math.floor(dimensions().height / 2) - 6))

  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      // The shared Dialog panel stops mouse-up propagation to prevent click-outside-close,
      // which also blocks the provider-level copy-on-select. Copy here, on the panel root,
      // before the event bubbles up and is cut — covers the metadata, the markdown body, and
      // the file path row alike.
      onMouseUp={() => Selection.copy(renderer, toast, clipboard)}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("dialog.memory_content_title", {
            name:
              (item()?.header?.name ?? path.basename(props.file, ".md")) +
              (expired() ? `（${t("dialog.memory_expired")}）` : ""),
          })}
        </text>
        <text fg={theme.textMuted} onMouseUp={afterEvent(back)}>
          {t("dialog.esc")}
        </text>
      </box>
      {/* No loading branch: the panel keeps the same shape while the file is read, and the
          metadata scrolls with the content instead of resizing the panel when it arrives. */}
      <scrollbox height={height()}>
        <Show when={item()} fallback={<text fg={theme.error}>{failure() ?? t("dialog.memory_missing")}</text>}>
          <box paddingLeft={1}>
            <For each={meta()}>
              {(row) => (
                <text>
                  <span style={{ fg: theme.textMuted }}>{row.key}</span>
                  <span style={{ fg: theme.text }}>{row.value}</span>
                </text>
              )}
            </For>
          </box>
          <box paddingLeft={1} paddingRight={1} paddingTop={1}>
            <markdown
              syntaxStyle={syntax()}
              internalBlockMode="top-level"
              content={item()?.body ?? ""}
              tableOptions={{ style: "grid" }}
              fg={theme.markdownText}
              bg={theme.backgroundPanel}
            />
          </box>
        </Show>
      </scrollbox>
      <text fg={theme.textMuted}>{props.file}</text>
      <Show when={item()}>
        <box flexDirection="row" gap={2}>
          <text onMouseUp={afterEvent(remove)}>
            <span style={{ fg: theme.text }}>
              <b>{t("dialog.action_delete")}</b>{" "}
            </span>
            <span style={{ fg: theme.textMuted }}>{deleteHint()}</span>
          </text>
        </box>
      </Show>
      <box paddingBottom={1} />
    </box>
  )
}
