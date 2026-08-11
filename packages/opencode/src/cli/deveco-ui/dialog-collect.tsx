import { TextAttributes, ScrollBoxRenderable } from '@opentui/core';
import { useTheme } from '@opencode-ai/tui/context/theme';
import { useDialog } from '@opencode-ai/tui/ui/dialog';
import { useToast } from '@opencode-ai/tui/ui/toast';
import { useI18n } from '@opencode-ai/tui/i18n';
import { createStore } from 'solid-js/store';
import { onMount, Show, createSignal, createMemo, For } from 'solid-js';
import { useBindings } from '@opencode-ai/tui/keymap';
import { useTerminalDimensions } from '@opentui/solid';
import open from 'open';
import { AGREEMENT_DEFAULTS } from '@/cli/deveco-legal';
import { listLogFiles, packLogs, uploadLogs, logInfo, logError } from '@/cli/cmd/debug/log-export';
import { deleteCrashedFlag } from '@/cli/crash-detect';

interface LogFile {
  path: string;
  label: string;
  group: string;
}

type Field =
  | { type: 'group'; group: string; label: string }
  | { type: 'file'; index: number }
  | { type: 'upload' };

export function DialogCollect(props: { triggerType?: string }) {
  const dialog = useDialog();
  const { theme } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const dimensions = useTerminalDimensions();

  const logFiles = createMemo<LogFile[]>(() => listLogFiles());

  // Initialize: deveco group checked, mcp group unchecked
  const initialFiles = logFiles();
  const initialChecked: Record<number, boolean> = {};
  for (let i = 0; i < initialFiles.length; i++) {
    initialChecked[i] = initialFiles[i].group !== 'mcp';
  }
  const [checked, setChecked] = createStore<Record<number, boolean>>(initialChecked);
  const [active, setActive] = createSignal<number>(0);
  const [uploading, setUploading] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal('');
  let scroll: ScrollBoxRenderable | undefined;

  const scrollMaxHeight = createMemo(() => {
    const h = dimensions().height;
    return Math.max(5, Math.floor(h / 3));
  });

  onMount(() => {
    dialog.setSize('large');
  });

  // Build the list of navigable fields: group headers + files + agree + upload
  const fields = createMemo<Field[]>(() => {
    const files = logFiles();
    const result: Field[] = [];
    const groups: { group: string; label: string }[] = [];
    if (files.some((f) => f.group === 'deveco')) {
      groups.push({ group: 'deveco', label: t('dialog.collect_main_logs') });
    }
    if (files.some((f) => f.group === 'mcp')) {
      groups.push({ group: 'mcp', label: t('dialog.collect_mcp_logs') });
    }

    let fileIdx = 0;
    for (const g of groups) {
      result.push({ type: 'group', group: g.group, label: g.label });
      while (fileIdx < files.length && files[fileIdx].group === g.group) {
        result.push({ type: 'file', index: fileIdx });
        fileIdx++;
      }
    }
    result.push({ type: 'upload' });
    return result;
  });

  const groupChecked = createMemo(() => {
    const files = logFiles();
    const map: Record<string, boolean> = {};
    for (const g of ['deveco', 'mcp']) {
      const groupFiles = files.filter((f) => f.group === g);
      if (groupFiles.length > 0) {
        map[g] = groupFiles.every((f) => checked[files.indexOf(f)] === true);
      }
    }
    return map;
  });

  const isGroupAllChecked = (group: string) => groupChecked()[group] === true;

  const toggleGroup = (group: string) => {
    const files = logFiles();
    const allChecked = isGroupAllChecked(group);
    for (const f of files.filter((f) => f.group === group)) {
      const idx = files.indexOf(f);
      setChecked(idx, !allChecked);
    }
  };

  const scrollToActive = () => {
    if (!scroll) {
      return;
    }
    const cur = active();
    const target = scroll.getChildren()[cur];
    if (!target) {
      return;
    }
    const y = target.y - scroll.y;
    if (y < 0) {
      scroll.scrollBy(y);
    } else if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1);
    }
  };

  useBindings(() => ({
    bindings: [
      {
        key: 'tab',
        desc: 'Next',
        group: 'Dialog',
        cmd: () => {
          const total = fields().length;
          if (total === 0) {
            return;
          }
          setActive((prev) => (prev + 1) % total);
          setTimeout(scrollToActive, 0);
        },
      },
      {
        key: 'down',
        desc: 'Next',
        group: 'Dialog',
        cmd: () => {
          const total = fields().length;
          if (total === 0) {
            return;
          }
          setActive((prev) => (prev + 1) % total);
          setTimeout(scrollToActive, 0);
        },
      },
      {
        key: 'up',
        desc: 'Previous',
        group: 'Dialog',
        cmd: () => {
          const total = fields().length;
          if (total === 0) {
            return;
          }
          setActive((prev) => (prev - 1 + total) % total);
          setTimeout(scrollToActive, 0);
        },
      },
      {
        key: 'space',
        desc: 'Click',
        group: 'Dialog',
        cmd: () => {
          const cur = active();
          const field = fields()[cur];
          if (!field) {
            return;
          }
          if (field.type === 'group') {
            toggleGroup(field.group);
          } else if (field.type === 'file') {
            setChecked(field.index, !checked[field.index]);
          }
        },
      },
      {
        key: 'v',
        desc: 'View Privacy Policy',
        group: 'Dialog',
        cmd: () => {
          open(AGREEMENT_DEFAULTS.privacy_url).catch(() => {});
        },
      },
      {
        key: 'return',
        desc: 'Upload',
        group: 'Dialog',
        cmd: () => void doUpload(),
      },
    ],
  }));

  async function doUpload() {
    if (uploading()) {
      return;
    }
    setErrorMsg('');
    const selected = logFiles().filter((_, i) => checked[i]);
    if (selected.length === 0) {
      setErrorMsg(t('toast.collect_select_one'));
      return;
    }

    setUploading(true);
    try {
      const archive = packLogs(selected.map((f) => f.path));
      if (!archive) {
        setErrorMsg(t('toast.collect_no_files'));
        setUploading(false);
        return;
      }
      logInfo('manual log upload started', { size: archive.length, files: selected.length });
      await uploadLogs(archive, props.triggerType ?? '00001');
      logInfo('manual log upload completed');
      deleteCrashedFlag();
      dialog.clear();
      toast.show({ message: t('toast.collect_success'), variant: 'success' });
    } catch (e) {
      logError('manual log upload failed', { error: String(e) });
      setErrorMsg(t('toast.collect_failed'));
    } finally {
      setUploading(false);
    }
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t('dialog.collect_title')}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {'esc'}
        </text>
      </box>

      <Show when={logFiles().length === 0}>
        <text fg={theme.textMuted}>No log files found</text>
      </Show>

      <Show when={logFiles().length > 0}>
        <scrollbox
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          maxHeight={scrollMaxHeight()}
          verticalScrollbarOptions={{ visible: true }}
          horizontalScrollbarOptions={{ visible: false }}
        >
          <For each={fields().filter((f) => f.type !== 'upload')}>
            {(field, fi) => {
              const allFields = fields();
              const realIdx = allFields.indexOf(field);

              if (field.type === 'group') {
                return (
                  <box
                    flexDirection="row"
                    gap={2}
                    paddingLeft={1}
                    backgroundColor={active() === realIdx ? theme.backgroundElement : undefined}
                    onMouseUp={() => {
                      setActive(realIdx);
                      toggleGroup(field.group);
                    }}
                  >
                    <text fg={active() === realIdx ? theme.primary : theme.textMuted}>
                      {groupChecked()[field.group] === true ? '[✓]' : '[ ]'}
                    </text>
                    <text fg={active() === realIdx ? theme.primary : theme.textMuted} attributes={TextAttributes.BOLD}>
                      {field.label}
                    </text>
                  </box>
                );
              }

              // file type
              const file = logFiles()[field.index];
              return (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={3}
                  backgroundColor={active() === realIdx ? theme.backgroundElement : undefined}
                  onMouseUp={() => {
                    setActive(realIdx);
                    setChecked(field.index, !checked[field.index]);
                  }}
                >
                  <text fg={active() === realIdx ? theme.primary : theme.textMuted}>
                    {checked[field.index] === true ? '[✓]' : '[ ]'}
                  </text>
                  <text fg={active() === realIdx ? theme.primary : theme.text}>{file.label}</text>
                </box>
              );
            }}
          </For>
        </scrollbox>
      </Show>

      <Show when={errorMsg()}>
        <box paddingLeft={1}>
          <text fg={theme.error}>{errorMsg()}</text>
        </box>
      </Show>

      <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingBottom={1}>
        <box flexDirection="row" gap={2}>
          <text>
            <span style={{ fg: theme.text }}><b>{t('dialog.collect_footer_navigate')}</b></span>
            <span style={{ fg: theme.textMuted }}> {t('dialog.collect_footer_navigate_key')}</span>
          </text>
          <text>
            <span style={{ fg: theme.text }}><b>{t('dialog.collect_footer_click')}</b></span>
            <span style={{ fg: theme.textMuted }}> {t('dialog.collect_footer_click_key')}</span>
          </text>
          <text>
            <span style={{ fg: theme.text }}><b>{t('dialog.collect_footer_view_privacy')}</b></span>
            <span style={{ fg: theme.textMuted }}> {t('dialog.collect_footer_view_privacy_key')}</span>
          </text>
        </box>
        <box flexDirection="row">
          <box
            paddingLeft={1}
            paddingRight={1}
            onMouseUp={() => {
              deleteCrashedFlag();
              dialog.clear();
            }}
          >
            <text fg={theme.textMuted}>
              {t('dialog.collect_skip')}
            </text>
          </box>
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.primary}
            onMouseUp={() => void doUpload()}
          >
            <text fg={theme.selectedListItemText}>
              {uploading() ? t('dialog.collect_uploading') : t('dialog.collect_upload')}
            </text>
          </box>
        </box>
      </box>
    </box>
  );
}
