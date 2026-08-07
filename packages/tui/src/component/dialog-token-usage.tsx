import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useI18n } from "../i18n"
import { useKV } from "../context/kv"

export type TokenUsageMode = "off" | "on" | "verbose"

export function DialogTokenUsage() {
  const { t } = useI18n()
  const dialog = useDialog()
  const kv = useKV()
  const current = kv.get("token_usage_mode", "off") as TokenUsageMode

  const options = [
    { title: t("dialog.token_usage_off"), value: "off" as TokenUsageMode },
    { title: t("dialog.token_usage_on"), value: "on" as TokenUsageMode },
    { title: t("dialog.token_usage_verbose"), value: "verbose" as TokenUsageMode },
  ]

  return (
    <DialogSelect
      title={t("dialog.token_usage_title")}
      options={options}
      current={current}
      onSelect={(opt) => {
        kv.set("token_usage_mode", opt.value)
        dialog.clear()
      }}
      skipFilter
      renderFilter={false}
    />
  )
}
