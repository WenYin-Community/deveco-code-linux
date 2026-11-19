import { MouseButton, RGBA, TextAttributes, TextRenderable, type MouseEvent } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, onMount, type JSX } from "solid-js"
import { AnnouncementBrowser } from "../announcements/browser"
import { announcementBody } from "../announcements/html"
import { announcementKey, type Announcement } from "../announcements/model"
import { useAnnouncements } from "../context/announcements"
import { useTheme } from "../context/theme"
import { useI18n } from "../i18n"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

const announcementLinkBlue = { dark: RGBA.fromHex("#60a5fa"), light: RGBA.fromHex("#1d4ed8") }

export function DialogAnnouncements(props: {
  current?: string
  openSingleUnread?: boolean
  replace: (render: () => JSX.Element) => void
}) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const dialog = useDialog()
  const announcements = useAnnouncements()
  if (props.openSingleUnread && announcements.unread() === 1) {
    const item = announcements.items().find((item) => !item.read)
    if (item) return <AnnouncementDetail item={item} replace={props.replace} />
  }

  onMount(() => dialog.setSize("medium"))

  const options = createMemo(() =>
    announcements.items().map((item) => ({
      title: `${item.read ? "○" : "●"} ${item.title}`,
      description: new Date(item.publishTime).toLocaleString(),
      value: announcementKey(item),
    })),
  )
  const current = createMemo(() => {
    if (props.current !== undefined) return props.current
    const unread = announcements.items().find((item) => !item.read)
    return unread && announcementKey(unread)
  })

  return (
    <DialogSelect
      title={`${t("dialog.announcements_title")} (${t("dialog.announcements_unread", { count: announcements.unread() })})`}
      options={options()}
      current={current()}
      preserveSelection
      showCurrentMarker={false}
      renderFilter={false}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.textMuted}>{t("dialog.announcements_empty")}</text>
        </box>
      }
      onSelect={(option) => {
        const item = announcements.items().find((item) => announcementKey(item) === option.value)
        if (!item) return
        props.replace(() => <AnnouncementDetail item={item} replace={props.replace} />)
      }}
      footerHints={[{ title: "Enter", label: t("dialog.action_select") }]}
    />
  )
}

function AnnouncementDetail(props: { item: Announcement; replace: (render: () => JSX.Element) => void }) {
  const { t } = useI18n()
  const { theme, mode } = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const announcements = useAnnouncements()
  const dimensions = useTerminalDimensions()
  const body = createMemo(() => announcementBody(props.item.content, theme.markdownCode))
  const key = announcementKey(props.item)
  const back = () => props.replace(() => <DialogAnnouncements current={key} replace={props.replace} />)
  let pressedLink: string | undefined

  function linkAt(event: MouseEvent) {
    if (!(event.target instanceof TextRenderable) || !body().some((chunk) => chunk.href)) return
    const column = event.x - event.target.x
    const row = event.y - event.target.y
    const line = event.target.lineInfo
    if (line.lineStartCols[row] === undefined || column < 0 || column >= line.lineWidthCols[row]) return

    // Convert the visual row to a display-column offset in the original chunks.
    const offset = line.lineStartCols[row] + column
    let end = 0
    for (const chunk of body()) {
      // OpenTUI counts newlines as one column and tabs as two columns in these offsets.
      end += Bun.stringWidth(chunk.text.replaceAll("\n", " ").replaceAll("\t", "  "))
      if (offset < end) return chunk.href
    }
  }

  function openLink(event: MouseEvent) {
    const href = pressedLink
    pressedLink = undefined
    if (event.button !== MouseButton.LEFT || !href || href !== linkAt(event)) return
    void AnnouncementBrowser.open(href)
      .catch(() => false)
      .then((opened) => {
        if (!opened) toast.show({ message: t("dialog.announcements_link_failed"), variant: "error" })
      })
  }

  onMount(() => {
    dialog.setSize("xlarge")
    void announcements
      .markRead(key)
      .catch(() => toast.show({ message: t("dialog.announcements_read_failed"), variant: "error" }))
  })

  useBindings(() => ({
    bindings: [{ key: "left", desc: t("dialog.action_back"), group: t("category.dialog"), cmd: back }],
  }))

  return (
    <box
      gap={1}
      paddingTop={1}
      paddingBottom={1}
      maxHeight={Math.max(1, Math.floor((3 * dimensions().height) / 4) - 2)}
    >
      <box paddingLeft={3} paddingRight={3} flexShrink={0}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD} flexShrink={1}>
            {props.item.title}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            {t("dialog.esc")}
          </text>
        </box>
        <text fg={theme.textMuted}>{new Date(props.item.publishTime).toLocaleString()}</text>
      </box>
      <scrollbox
        flexShrink={1}
        minHeight={0}
        paddingLeft={3}
        paddingRight={3}
        scrollbarOptions={{ visible: false }}
      >
        <text
          fg={theme.text}
          onMouseDown={(event) => {
            pressedLink = event.button === MouseButton.LEFT ? linkAt(event) : undefined
          }}
          onMouseDrag={() => {
            pressedLink = undefined
          }}
          onMouseUp={openLink}
        >
          <For each={body()}>
            {(chunk) => {
              const attributes = chunk.attributes ?? TextAttributes.NONE
              const style = () => ({
                fg: chunk.href ? announcementLinkBlue[mode()] : chunk.fg,
                bold: (attributes & TextAttributes.BOLD) !== 0,
                italic: (attributes & TextAttributes.ITALIC) !== 0,
                underline: (attributes & TextAttributes.UNDERLINE) !== 0,
              })
              return chunk.href ? (
                <a href={chunk.href} style={style()}>
                  {chunk.text}
                </a>
              ) : (
                <span style={style()}>{chunk.text}</span>
              )
            }}
          </For>
        </text>
      </scrollbox>
      <box paddingLeft={3} paddingRight={3} flexShrink={0} flexDirection="row" gap={3}>
        <text fg={theme.textMuted} onMouseUp={back}>
          ← {t("dialog.action_back")}
        </text>
      </box>
    </box>
  )
}
