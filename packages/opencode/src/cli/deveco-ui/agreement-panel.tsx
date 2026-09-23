import { useI18n } from "@opencode-ai/tui/i18n"
import { createEffect, createMemo, createResource, createSignal, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useSync } from "@opencode-ai/tui/context/sync"
import { useSDK } from "@opencode-ai/tui/context/sdk"
import { useTheme } from "@opencode-ai/tui/context/theme"
import { useBindings } from "@opencode-ai/tui/keymap"
import { Link } from "@opencode-ai/tui/ui/link"
import { DialogSelect } from "@opencode-ai/tui/ui/dialog-select"
import open from "open"
import { hasDevecoOAuthEntry } from "@/plugin/deveco"
import { logWarn } from "@/plugin/deveco/log"
import {
  getCurrentImprovementConsent,
  loadUserIdFromDisk,
  setCurrentImprovementConsent,
} from "@/plugin/deveco/improvement-consent"

export function AgreementPanel(props: {
  onComplete?: () => void
  maxHeight?: number
  review?: boolean
  /** Worker notification channel for the improvement checkbox (design §6.6 / B5). */
  onImprovementChange?: (enabled: boolean) => void | Promise<void>
}) {
  const { t, lng } = useI18n()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [state, setState] = createStore({ checked: false, busy: false, error: "" })
  const [agreement, { refetch }] = createResource(async () => {
    const result = await sdk.client.global.productAgreement({ throwOnError: true })
    if (!result.data?.upload) throw new Error(t("account.server_update"))
    setState("checked", false)
    return result.data
  })
  // Improvement opt-in row (design §6.2 / D5 / D11). "skip" = no account to ask
  // about (not signed in, or userId unresolvable → no decision can be attached).
  const [impState] = createResource(async () => {
    if (!hasDevecoOAuthEntry()) return "skip"
    // I-4/S7 writable check: userId must resolve from token.enc — an
    // auth.json entry alone is not enough, and the row must never offer a
    // confirm that cannot be attached to an account (ST-3). The divergence
    // (auth.json entry present, token.enc unreadable) gets a log line so the
    // hidden-row state is diagnosable (design §6.5 boundary 1).
    if (!(await loadUserIdFromDisk())) {
      logWarn("improvement consent row locked: oauth entry present but userId unresolvable", { service: "deveco" })
      return "skip"
    }
    return await getCurrentImprovementConsent()
  })
  const [imp, setImp] = createStore({ visible: false, checked: false })
  // I2: createResource also yields undefined while loading — only a *ready*
  // value is meaningful. Showing the row earlier would let a confirm race an
  // in-flight check and overwrite an existing grant with a spurious decline
  // (FR-5 / D4).
  //
  // 2026-09-23: 只要决定**可读**就显示该行，并**回显**已有决定（勾选 = 已同意）。
  // 原实现只在"未表态"时显示（D6 的"已决定不呈现"），结果是已同意 improvement 的
  // 用户在协议签署界面看不到自己的选择。回显不等于"重问"：act() 只在用户**改动**
  // 了该行时才写盘（见下），单纯接受协议不会覆盖已有决定。
  createEffect(() => {
    if (impState.state !== "ready") return
    const value = impState()
    if (value === "skip") return
    setImp({ visible: true, checked: value === "granted" })
  })
  /**
   * 中文标签是一整串无空格的中文：`word` 模式会把中文标点当词边界、把标点后的长串当成
   * 不可断的"单词"，于是会在标点处提前折行。中文用 `char` 逐字断行（与弹窗 notice 同一处理）。
   */
  const labelWrap = () => (lng().startsWith("zh") ? "char" : "word")
  const needsConsent = () =>
    !agreement.error && (!agreement()?.accepted || agreement()?.upload.state === "review_required")
  const acceptConsent = async (current: NonNullable<ReturnType<typeof agreement>>) => {
    await sdk.client.global.acceptProductAgreement(
      {
        version: current.version,
        accepted: true,
        serviceRevision: current.upload.revision,
      },
      { throwOnError: true },
    )
    await refetch()
    // A newer revision can be published while the acceptance is in flight, and
    // the refetch above is the only read that sees it. Re-check before
    // forwarding so both completion paths protect the same invariant: never
    // hand the gate a completion while consent is still outstanding.
    if (needsConsent()) {
      setState("checked", false)
      return
    }
    props.onComplete?.()
  }

  // 键盘可勾选的行，按渲染顺序。某一行不可见时自动退出导航序列，因此
  // "只剩 Improvement 行"（协议已接受）时焦点自然落在它身上，无需额外分支。
  const [focus, setFocus] = createSignal<"agreement" | "improvement">("agreement")
  const rows = () => [
    ...(needsConsent() ? (["agreement"] as const) : []),
    ...(imp.visible ? (["improvement"] as const) : []),
  ]
  // 焦点可能因行消失而失效（例如中途协议变为已接受）→ 回退到第一个可见行
  const focused = () => (rows().includes(focus()) ? focus() : rows()[0])
  const moveFocus = (delta: 1 | -1) => {
    const list = rows()
    if (list.length < 2) return
    setFocus(list[(list.indexOf(focused()!) + delta + list.length) % list.length])
  }
  // Space 作用于**当前行**。此前它硬绑在协议行上，导致 Improvement 行
  // 只能靠鼠标（或不可发现的 i 键）勾选。
  /** 勾选协议行；勾上后清掉"必须勾选协议"的提示。 */
  const toggleAgreement = () => {
    setState("checked", !state.checked)
    // L1 fix: clear ONLY the "check the agreement first" hint. `state.error` also
    // carries a failed submit ("Unable to update agreements…"), and clearing that
    // on a re-toggle would silently hide why the accept failed.
    if (state.checked && state.error === t("account.agree_required")) setState("error", "")
  }
  const toggleFocused = () => {
    if (focused() === "agreement") toggleAgreement()
    if (focused() === "improvement") setImp("checked", !imp.checked)
  }

  const act = async () => {
    if (state.busy) return
    if (agreement.error) {
      await Promise.resolve(refetch()).catch(() => {})
      return
    }
    const current = agreement()
    if (!current) return
    // Enter without checking the required agreement: say so in red at the bottom
    // instead of silently doing nothing.
    if (needsConsent() && !state.checked) {
      setState("error", t("account.agree_required"))
      return
    }
    setState({ busy: true, error: "" })
    try {
      // I1: persist the improvement decision BEFORE both props.onComplete
      // branches below — both return right after onComplete, so anything
      // placed after them would be skipped. Unchecked = declined (FR-4);
      // a failed write leaves no record, so the next login asks again (F4).
      //
      // 2026-09-23: 该行现在会**回显**已有决定，所以这里必须区分两种情况：
      //   - 未表态 → 无论勾选与否都要落一条决定（FR-4：不勾选 = 拒绝）
      //   - 已决定 → 只有用户**改动**了该行才写；单纯接受协议不得覆盖已有决定
      const undecided = impState() === undefined
      const changed = imp.checked !== (impState() === "granted")
      if (imp.visible && (undecided || changed)) {
        await setCurrentImprovementConsent(imp.checked)
        await props.onImprovementChange?.(imp.checked)
      }
      if (needsConsent()) {
        await acceptConsent(current)
        return
      }
      // Nothing to accept: the gate owns the authoritative agreement state, so hand
      // the decision straight back to it. Re-reading here would only return the
      // pre-click snapshot — it is the gate's own upload retry that discovers a new
      // required revision — and a forced GET would turn a local step transition
      // into a network failure surface.
      props.onComplete?.()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : t("account.update_failed"))
      await Promise.resolve(refetch()).catch(() => {})
    } finally {
      setState("busy", false)
    }
  }
  useBindings(() => ({
    bindings: [
      { key: "up", desc: t("account.select_action"), group: t("account.agreements"), cmd: () => moveFocus(-1) },
      { key: "down", desc: t("account.select_action"), group: t("account.agreements"), cmd: () => moveFocus(1) },
      {
        key: "space",
        desc: t("account.toggle_action"),
        group: t("account.agreements"),
        cmd: () => toggleFocused(),
      },
      {
        // 保留为 Improvement 行的快捷方式（既有行为与测试依赖它）。
        // 主路径现在是 ↑↓ 选行 + Space 勾选当前行。
        key: "i",
        desc: t("account.improvement_toggle"),
        group: t("account.agreements"),
        cmd: () => {
          if (imp.visible) setImp("checked", !imp.checked)
        },
      },
      { key: "return", desc: t("account.continue"), group: t("account.agreements"), cmd: () => void act() },
    ],
  }))
  return (
    <box flexDirection="column" width="100%" padding={1} gap={1} alignItems="center">
      <text fg={theme.text}>
        <b>{props.review ? t("account.review_title") : t("account.agreements_privacy")}</b>
      </text>
      <Show when={props.review}>
        <text fg={theme.textMuted}>{t("account.review_message")}</text>
      </Show>
      <Show when={agreement.error}>
        <text fg={theme.error}>{t("account.load_failed")}</text>
      </Show>
      <Show when={agreement.loading}>
        <text fg={theme.textMuted}>{t("account.loading_agreements")}</text>
      </Show>
      <Show when={!agreement.error && agreement()}>
        {(current) => (
          <>
            <box flexDirection="column" gap={1} alignItems="center">
              <Link href={current().termsUrl}>{t("account.terms")}</Link>
              <Link href={current().privacyUrl}>{t("account.privacy_notice")}</Link>
            </box>
            {/* 选项列表：两行包在同一个满宽容器里，因此共享同一左边界。
                为什么是 100% 而不是留缩进做"居中"观感——这两行要同时满足两个约束：
                  ① 共享左边界：上游把面板改成居中（alignItems="center"）后，短的协议行会飘到
                     中间，而 Improvement 行必须满宽（长文案换行 + 悬挂缩进），两者就对不齐；
                  ② 协议行不能被压窄：英文标签占 77 列，80 列终端只有 78 列可用，任何缩进
                     （例如曾用过的 90%）都会让它在 80 列终端折行。
                所以取满宽：对齐靠"共容器"保证，而不是靠缩进。 */}
            <box flexDirection="column" gap={1} width="100%">
              <Show when={needsConsent()}>
                <text
                  fg={focused() === "agreement" ? theme.primary : theme.text}
                  onMouseUp={() => {
                    setFocus("agreement")
                    toggleAgreement()
                  }}
                >
                  {focused() === "agreement" ? "❯" : " "} {state.checked ? "[✓]" : "[ ]"}{" "}
                  {t("account.required_marker")} {t("account.consent")}
                </text>
              </Show>
              <Show when={imp.visible}>
                {/* 2026-09-23 (layout): the label and its changeability note are ONE flowing
                    paragraph, so the note always trails the text instead of becoming a detached
                    line. The paragraph lives in a column to the right of the "❯ [ ] " prefix:
                    that narrows the wrap width (so a long CJK label wraps and the note lands at
                    the end of the last line, exactly like the English row) and gives wrapped
                    continuation lines a hanging indent under the label instead of column 0. */}
                <box flexDirection="row">
                  <text
                    fg={focused() === "improvement" ? theme.primary : theme.text}
                    // flexShrink={0}: the "❯ [ ] " prefix is fixed geometry — without it a
                    // narrow terminal squeezes the trailing space away ("[ ](Optional)").
                    flexShrink={0}
                    onMouseUp={() => {
                      setFocus("improvement")
                      setImp("checked", !imp.checked)
                    }}
                  >
                    {focused() === "improvement" ? "❯" : " "} {imp.checked ? "[✓]" : "[ ]"}{" "}
                  </text>
                  <box flexGrow={1} flexShrink={1} flexBasis={0} flexDirection="column">
                    <text
                      fg={focused() === "improvement" ? theme.primary : theme.text}
                      wrapMode={labelWrap()}
                      onMouseUp={() => {
                        setFocus("improvement")
                        setImp("checked", !imp.checked)
                      }}
                    >
                      {t("account.optional_marker")} {t("account.improvement_consent")}
                      <span style={{ fg: theme.textMuted }}> · {t("account.improvement_change_hint")}</span>
                    </text>
                  </box>
                </box>
              </Show>
            </box>
            <text fg={theme.primary} onMouseUp={() => void act()}>
              {state.busy ? t("account.wait") : needsConsent() ? t("account.agree_hint") : t("account.continue")}
            </text>
          </>
        )}
      </Show>
      <Show when={state.error}>
        <text fg={theme.error}>{state.error}</text>
      </Show>
    </box>
  )
}

export function AgreementReviewDialog(props: { onComplete: () => void }) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const sdk = useSDK()
  const [state, setState] = createStore({ checked: false, busy: false, error: "" })
  const [agreement, { refetch }] = createResource(async () => {
    const result = await sdk.client.global.productAgreement({ throwOnError: true })
    if (!result.data?.upload) throw new Error(t("account.server_update"))
    return result.data
  })
  const accept = async () => {
    const current = agreement()
    if (!current || state.busy) return
    setState("checked", true)
    setState({ busy: true, error: "" })
    try {
      await sdk.client.global.acceptProductAgreement(
        { version: current.version, accepted: true, serviceRevision: current.upload.revision },
        { throwOnError: true },
      )
      props.onComplete()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : t("account.update_failed"))
      await Promise.resolve(refetch()).catch(() => {})
    } finally {
      setState("busy", false)
    }
  }
  const options = createMemo(() => {
    const current = agreement()
    if (!current) {
      return [
        {
          title: agreement.error ? t("account.load_failed") : t("account.loading_agreements"),
          description: agreement.error ? t("account.retry_description") : undefined,
          value: "retry",
          onSelect: (): void => void Promise.resolve(refetch()).catch(() => {}),
        },
      ]
    }
    return [
      {
        title: t("account.terms"),
        description: t("account.terms_description"),
        value: "terms",
        category: t("account.review_reading"),
        onSelect: (): void => void open(current.termsUrl).catch(() => {}),
      },
      {
        title: t("account.privacy_notice"),
        description: t("account.privacy_description"),
        value: "privacy",
        category: t("account.review_reading"),
        onSelect: (): void => void open(current.privacyUrl).catch(() => {}),
      },
      {
        title: `${state.checked ? "[✓]" : "[ ]"} ${t("account.review_consent")}`,
        value: "consent",
        category: t("account.review_actions"),
        onSelect: (): void => setState("checked", !state.checked),
      },
      {
        title: state.busy ? t("account.wait") : t("account.review_confirm"),
        description: state.error || undefined,
        value: "confirm",
        category: t("account.review_actions"),
        onSelect: (): void => void accept(),
      },
    ]
  })
  return (
    <DialogSelect
      title={t("account.review_title")}
      notice={
        <text fg={theme.textMuted} wrapMode="word">
          {t("account.review_message")}
        </text>
      }
      options={options()}
      renderFilter={false}
      skipFilter={true}
      locked={state.busy}
      bindings={[
        {
          key: "space",
          desc: t("account.agree_action"),
          group: t("account.agreements"),
          cmd: () => setState("checked", !state.checked),
        },
      ]}
      footerHints={[
        { title: "Space", label: t("dialog.action_toggle") },
        { title: "Enter", label: t("account.select") },
      ]}
    />
  )
}

export function ProductAgreementGate(props: ParentProps<{ home: boolean; onConsentRequired: () => void }>) {
  const sync = useSync()
  const { t } = useI18n()
  const { theme } = useTheme()
  const sdk = useSDK()
  const [agreement, { refetch }] = createResource(
    () => (props.home ? undefined : true),
    async () => {
      const result = await sdk.client.global.productAgreement({ throwOnError: true })
      if (!result.data?.upload) throw new Error(t("account.server_update"))
      if (result.data.accepted) void sdk.client.global.retryAgreementUpload({ force: false }).catch(() => {})
      return result.data
    },
  )
  createEffect(() => {
    if (!props.home && agreement() && !agreement()?.accepted) props.onConsentRequired()
  })
  return (
    <Show
      when={props.home || (!agreement.error && agreement()?.accepted)}
      fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text
            fg={agreement.error ? theme.error : theme.textMuted}
            onMouseUp={() => agreement.error && void refetch()}
          >
            {agreement.error ? t("account.load_failed") : t("account.checking_setup")}
          </text>
        </box>
      }
    >
      <Show
        when={!sync.data.local_auth_error}
        fallback={
          <box padding={2}>
            <text>
              {sync.data.local_auth_error} {t("account.reset_help")}
            </text>
          </box>
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}
