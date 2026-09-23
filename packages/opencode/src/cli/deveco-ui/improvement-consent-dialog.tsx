/**
 * Improvement consent dialog (design §6.4 / D6) — the standalone ask surface
 * for accounts that reached the main UI without an improvement decision:
 * in-app login (A3), CLI login then TUI (A4), and upgraded installs (C1).
 * Opened by home-body's fallback effect via the `improvementConsentDialog`
 * extension point.
 *
 * **Question style (2026-09-23)**: the ask is three explicit choices rather
 * than a checkbox plus confirm, so the intent of each action is unambiguous:
 *   - 同意   → `granted = true`，落盘后关闭
 *   - 拒绝   → `granted = false`，落盘后关闭（FR-4：不勾选也要留下决定）
 *   - 取消   → **不写任何记录**，账号保持"未表态" → 下次启动再问（F4）
 *   - `esc` 与"取消"同义（对话框栈默认关闭，不落盘）
 *
 * 每个选项前带 `[✓]/[ ]` 勾选框，**勾号跟随光标**（单选语义），回车确认当前项。
 *
 * The honest disclosure (what is shared, and that collection only happens on
 * DevEco Code-provided models) lives in the `notice` block: with the checkbox
 * gone there is no option label left to carry it (UI-4 / design §8.1 S10).
 */
import { useI18n } from "@opencode-ai/tui/i18n"
import { createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@opencode-ai/tui/context/theme"
import { DialogSelect, type DialogSelectOption } from "@opencode-ai/tui/ui/dialog-select"
import { setCurrentImprovementConsent } from "@/plugin/deveco/improvement-consent"

type Choice = "agree" | "decline" | "cancel"

export function ImprovementConsentDialog(props: {
  onComplete: () => void
  /** Worker notification channel — same binding /privacy's improvement row uses. */
  onImprovementChange?: (enabled: boolean) => void | Promise<void>
}) {
  const { t, lng } = useI18n()
  const { theme } = useTheme()
  const [state, setState] = createStore({ busy: false, error: "" })
  /**
   * CJK 没有空格：`wrapMode="word"` 会把中文标点当作词边界，而标点后的长中文串是
   * 一个"不可断的单词"，于是"加入体验改进计划，"之后会**提前折行**、整行填不满
   * （用户实测）。中文改用 `char`（逐字断行、填满整行）；英文仍用 `word`，否则会把
   * 单词从中间断开。
   */
  const noticeWrap = () => (lng().startsWith("zh") ? "char" : "word")

  /**
   * Record an explicit decision and close.
   *
   * I-4 contract: `setCurrentImprovementConsent` returns false when nothing was
   * written (userId unresolvable / disk failure). In that case stay open with an
   * error — closing silently would leave the user believing they had chosen.
   */
  const decide = async (granted: boolean) => {
    if (state.busy) return
    setState({ busy: true, error: "" })
    if (!(await setCurrentImprovementConsent(granted))) {
      setState({ busy: false, error: t("account.improvement_update_failed") })
      return
    }
    // P10 fix (2026-09-23): a throwing notification must not leave the dialog
    // permanently busy (locked) — mirror the privacy row's try/catch.
    try {
      await props.onImprovementChange?.(granted)
    } catch {
      // Local-first: the record is already written, the worker can catch up.
    }
    setState("busy", false)
    props.onComplete()
  }

  /** 取消：不落盘，账号仍是"未表态"，下次启动会再次询问（F4）。 */
  const cancel = () => {
    if (state.busy) return
    props.onComplete()
  }

  /**
   * 单选语义：每个选项前有 `[✓]/[ ]`，勾号**跟随光标**（`onMove` 在方向键 /
   * 鼠标移动时触发），回车确认当前勾选项。初始勾选第一项，与 DialogSelect 的
   * 初始 selection（index 0）保持一致。
   */
  const [selected, setSelected] = createSignal<Choice>("agree")
  const options = createMemo((): DialogSelectOption<Choice>[] => {
    const mark = (choice: Choice) => (selected() === choice ? "[✓]" : "[ ]")
    return [
      {
        title: `${mark("agree")} ${state.busy ? t("account.wait") : t("account.improvement_agree")}`,
        value: "agree",
        onSelect: (): void => void decide(true),
      },
      {
        title: `${mark("decline")} ${t("account.improvement_decline")}`,
        value: "decline",
        onSelect: (): void => void decide(false),
      },
      {
        title: `${mark("cancel")} ${t("account.improvement_cancel")}`,
        value: "cancel",
        onSelect: (): void => cancel(),
      },
    ]
  })

  return (
    <DialogSelect
      title={t("account.improvement_title")}
      notice={
        <box flexDirection="column">
          {/* UI-4: 如实告知上报范围（含"仅内置模型才采集"）必须始终可见 */}
          <text fg={theme.text} wrapMode={noticeWrap()}>
            {t("account.improvement_consent")}
          </text>
          {/* 提示行含可断的空格，且可能带英文品牌名 → 保持 word；用 char 会把品牌名从中间切断 */}
          <text fg={theme.textMuted} wrapMode="word">
            {t("account.improvement_consent_hint")}
          </text>
          <Show when={state.error}>
            <text fg={theme.error}>{state.error}</text>
          </Show>
        </box>
      }
      options={options()}
      onMove={(option) => setSelected(option.value)}
      renderFilter={false}
      skipFilter={true}
      locked={state.busy}
      footerHints={[
        { title: "↑↓", label: t("account.select_action") },
        { title: "Enter", label: t("dialog.confirm") },
      ]}
    />
  )
}
