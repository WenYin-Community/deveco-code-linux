import { useI18n } from "@opencode-ai/tui/i18n"
import { AgreementPanel } from "./agreement-panel"
import { Show, createSignal, createMemo, For, createEffect, onMount, type ParentProps } from 'solid-js';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { useTheme } from '@opencode-ai/tui/context/theme';
import { useSync } from '@opencode-ai/tui/context/sync';
import { useExit } from '@opencode-ai/tui/context/exit';
import { useDialog } from '@opencode-ai/tui/ui/dialog';
import { useSDK } from '@opencode-ai/tui/context/sdk';
import { useLocal } from '@opencode-ai/tui/context/local';
import { DialogSelect } from '@opencode-ai/tui/ui/dialog-select';
import { DialogPrompt } from '@opencode-ai/tui/ui/dialog-prompt';
import { Link } from '@opencode-ai/tui/ui/link';
import { useToast } from '@opencode-ai/tui/ui/toast';
import { Spinner } from '@opencode-ai/tui/component/spinner';
import open from 'open';
import { devecoAuth, ACCESS_TOKEN_EXPIRES_MS, saveAuthToDisk } from '@/plugin/deveco';
import { logInfo, logWarn, logError } from '@/plugin/deveco/log';
import { resolveDevEcoHome, saveDevEcoHome, findDevEcoHomes, hasConfiguredDevEcoHome } from '@/tool/lib/env';
import HuaweiEndpoints from '../../../huawei-endpoints.json';
import { BANNER_HOME_CONTENT_INSET, HOME_CONTENT_MAX_WIDTH, homeContentPadX } from '@opencode-ai/tui/component/banner';

import type { ProviderAuthAuthorization, ProviderAuthMethod } from '@opencode-ai/sdk/v2';

type OnboardingStep = 'privacy' | 'product-privacy' | 'entry' | 'auth' | 'deveco-home' | 'providers' | 'key' | 'realname';



function OnboardingContent(props: ParentProps) {
  const dimensions = useTerminalDimensions();
  const padX = createMemo(() => homeContentPadX(Math.floor(dimensions().width)));
  return (
    <box
      flexDirection='column'
      alignItems='center'
      width='100%'
      maxWidth={HOME_CONTENT_MAX_WIDTH}
      paddingLeft={padX()}
      paddingRight={padX()}
    >
      {props.children}
    </box>
  );
}

function selectionLead(selected: boolean): string {
  return selected ? '> ' : '  ';
}

function providerLabel(id: string, name: string): string {
  if (id === 'github-copilot') {
    return 'GitHub Copilot';
  }
  return name;
}

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  'opencode-go': 1,
  openai: 2,
  'github-copilot': 3,
  anthropic: 4,
  google: 5,
  openrouter: 6,
};

const DEFAULT_AUTH_METHODS: ProviderAuthMethod[] = [{ type: 'api', label: 'API key' }];

type AuthDialog = ReturnType<typeof useDialog>;
type AuthSdk = ReturnType<typeof useSDK>;
type AuthTheme = ReturnType<typeof useTheme>['theme'];

type ProviderAuthContext = {
  dialog: AuthDialog;
  sdk: AuthSdk;
  theme: AuthTheme;
  finish: () => Promise<void>;
  t: ReturnType<typeof useI18n>["t"];
};

async function pickAuthMethodIndex(dialog: AuthDialog, methods: ProviderAuthMethod[], t: ReturnType<typeof useI18n>["t"]): Promise<number | null> {
  if (methods.length <= 1) {
    return 0;
  }
  const idx = await new Promise<number | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogSelect
          title={t("dialog.select_auth_method")}
          options={methods.map((m, i) => ({
            title: m.label,
            value: i,
          }))}
          onSelect={(opt) => resolve(opt.value)}
        />
      ),
      () => resolve(null),
    );
  });
  if (idx === null) {
    return null;
  }
  dialog.clear();
  return idx;
}

async function collectProviderAuthPrompts(
  dialog: AuthDialog,
  prompts: NonNullable<ProviderAuthMethod['prompts']>,
): Promise<Record<string, string> | null> {
  const inputs: Record<string, string> = {};
  for (const p of prompts) {
    if (p.when) {
      const prev = inputs[p.when.key];
      if (prev === undefined) {
        continue;
      }
      const matches = p.when.op === 'eq' ? prev === p.when.value : prev !== p.when.value;
      if (!matches) {
        continue;
      }
    }

    if (p.type === 'select') {
      const value = await new Promise<string | null>((resolve) => {
        dialog.replace(
          () => (
            <DialogSelect
              title={p.message}
              options={p.options.map((opt) => ({
                title: opt.label,
                value: opt.value,
                description: opt.hint,
              }))}
              onSelect={(opt) => resolve(opt.value)}
            />
          ),
          () => resolve(null),
        );
      });
      if (value === null) {
        return null;
      }
      inputs[p.key] = value;
      continue;
    }

    const value = await DialogPrompt.show(dialog, p.message, {
      placeholder: p.placeholder,
    });
    if (!value) {
      return null;
    }
    inputs[p.key] = value;
  }
  return inputs;
}

async function runOAuthCodeFlow(
  ctx: ProviderAuthContext,
  providerId: string,
  methodIndex: number,
  label: string,
  authorization: ProviderAuthAuthorization,
): Promise<boolean> {
  const code = await DialogPrompt.show(ctx.dialog, label, {
    placeholder: ctx.t("dialog.placeholder_authorization_code"),
    description: () => (
      <box gap={1}>
        <text fg={ctx.theme.textMuted}>{authorization.instructions}</text>
        <Link href={authorization.url} fg={ctx.theme.primary} />
      </box>
    ),
  });
  if (!code) {
    return false;
  }
  const cbResult = await ctx.sdk.client.provider.oauth.callback({
    providerID: providerId,
    method: methodIndex,
    code,
  });
  if (cbResult.error) {
    return false;
  }
  await ctx.finish();
  return true;
}

async function runOAuthAutoFlow(
  ctx: ProviderAuthContext,
  providerId: string,
  methodIndex: number,
  label: string,
  authorization: ProviderAuthAuthorization,
): Promise<boolean> {
  ctx.dialog.replace(() => (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <text fg={ctx.theme.text}>{label}</text>
      <box gap={1}>
        <Link href={authorization.url} fg={ctx.theme.primary} />
        <text fg={ctx.theme.textMuted}>{authorization.instructions}</text>
      </box>
      <text fg={ctx.theme.textMuted}>{ctx.t("dialog.waiting_for_authorization")}</text>
    </box>
  ));
  const cbResult = await ctx.sdk.client.provider.oauth.callback({
    providerID: providerId,
    method: methodIndex,
  });
  ctx.dialog.clear();
  if (cbResult.error) {
    return false;
  }
  await ctx.finish();
  return true;
}

async function runProviderOAuth(
  ctx: ProviderAuthContext,
  providerId: string,
  methodIndex: number,
  method: ProviderAuthMethod,
): Promise<void> {
  let inputs: Record<string, string> | undefined;
  if (method.prompts?.length) {
    const collected = await collectProviderAuthPrompts(ctx.dialog, method.prompts);
    if (collected === null) {
      return;
    }
    inputs = collected;
  }

  const result = await ctx.sdk.client.provider.oauth.authorize({
    providerID: providerId,
    method: methodIndex,
    inputs,
  });
  if (result.error) {
    ctx.dialog.clear();
    return;
  }

  if (result.data?.method === 'code') {
    await runOAuthCodeFlow(ctx, providerId, methodIndex, method.label, result.data);
    return;
  }

  if (result.data?.method === 'auto') {
    await runOAuthAutoFlow(ctx, providerId, methodIndex, method.label, result.data);
  }
}

export function DevEcoOnboarding(props: { onComplete: () => void; bodySlotHeight?: number; initialStep?: OnboardingStep; sessionExpired?: boolean; initialRealName?: boolean; initialAuthError?: string }) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const sync = useSync();
  const exit = useExit();
  const dialog = useDialog();
  const sdk = useSDK();
  const local = useLocal();
  const toast = useToast();

  // Initial step determined by caller: 'entry' if not logged in, 'privacy' if logged in but agreement pending
  const [step, setStep] = createSignal<OnboardingStep>(props.initialStep ?? 'entry')
  const [entryIndex, setEntryIndex] = createSignal(0);
  const [realnameIndex, setRealnameIndex] = createSignal(0);
  const [realnameRecheckError, setRealnameRecheckError] = createSignal<string | null>(null);
  const [authMessage, setAuthMessage] = createSignal<string | null>(props.initialAuthError ?? null);
  const [authBusy, setAuthBusy] = createSignal(false);
  const [providerIndex, setProviderIndex] = createSignal(0);
  let authAborted = false;
  let authReturnStep: 'entry' | 'realname' = 'entry';
  let productReturnStep: 'auth' | 'providers' | 'complete' = props.initialStep === 'product-privacy' ? 'complete' : 'auth';

  const continueSetup = () => {
    if (productReturnStep === 'complete') return props.onComplete();
    setStep(productReturnStep);
    if (productReturnStep === 'auth') {
      authReturnStep = 'entry';
      void runBrowserLogin();
    }
  };

  const chooseEntry = async () => {
    productReturnStep = entryIndex() === 0 ? 'auth' : 'providers';
    try {
      const result = await sdk.client.global.productAgreement({ throwOnError: true });
      if (!result.data) throw new Error(t("account.agreement_load_failed"));
      if (!result.data.accepted) {
        setStep('product-privacy');
        return;
      }
      continueSetup();
    } catch {
      setAuthMessage(t("account.agreement_read_failed"));
    }
  };
  const [providerQuery, setProviderQuery] = createSignal('');
  const [pid, setPid] = createSignal<string | null>(null);
  const [key, setKey] = createSignal('');
  let input: TextareaRenderable | undefined;
  let providerScroll: ScrollBoxRenderable | undefined;

  // DEVECO_HOME configuration step signals
  const [devecoHomeIndex, setDevecoHomeIndex] = createSignal(0);
  const [devecoHomeCandidates, setDevecoHomeCandidates] = createSignal<string[]>([]);
  const [devecoHomeBusy, setDevecoHomeBusy] = createSignal(false);
  const [devecoHomeInputMode, setDevecoHomeInputMode] = createSignal(false);
  const [devecoHomeInputValue, setDevecoHomeInputValue] = createSignal('');
  const [devecoHomeError, setDevecoHomeError] = createSignal<string | null>(null);
  let devecoHomeInput: TextareaRenderable | undefined;

  // Scan for installed DevEco Studio instances
  const runDevEcoHomeDetection = async () => {
    setDevecoHomeBusy(true);
    setDevecoHomeError(null);
    const candidates = await findDevEcoHomes();
    setDevecoHomeCandidates(candidates);
    setDevecoHomeIndex(0);
    setDevecoHomeBusy(false);
  };

  // Apply selected DevEco Studio path and transition to privacy step
  const applyDevEcoHomeAndContinue = async (home: string | undefined) => {
    if (home) {
      const resolved = await saveDevEcoHome(home);
      if (resolved) {
        process.env.DEVECO_HOME = resolved;
      }
    }
    setStep('privacy');
    void checkAgreementStatus();
  };

  // Submit custom DevEco Studio path
  const submitCustomDevEcoHome = async () => {
    const value = (devecoHomeInput?.plainText ?? devecoHomeInputValue()).trim();
    if (!value) return;
    setDevecoHomeError(null);
    const resolved = await resolveDevEcoHome(value);
    if (!resolved) {
      setDevecoHomeError(t("account.invalid_studio"));
      return;
    }
    await applyDevEcoHomeAndContinue(resolved);
  };

  const checkAgreementStatus = async () => {
    try {
      const result = await sdk.client.global.retryAgreementUpload({ force: false }, { throwOnError: true });
      if (result.data?.accepted && result.data.upload.state !== 'review_required') {
        props.onComplete();
        return;
      }
      setStep('privacy');
    } catch {
      setStep('privacy');
    }
  };

  // Kick off detection on mount when initial step requires it
  onMount(() => {
    if (props.initialRealName) {
      setStep('realname')
      return
    }
    if (props.sessionExpired) {
      // Caller already determined the session is expired — show the re-login prompt
      // without making another API call that would fail with the same expired token.
      setAuthMessage(t("account.session_expired"));
      setStep('entry')
      return
    }
    if (step() === 'privacy') {
      void checkAgreementStatus()
    }
    if (step() === 'deveco-home') {
      void runDevEcoHomeDetection()
    }
  })

  const providerList = createMemo(() => {
    return [...sync.data.provider_next.all]
      .filter((p) => p.id !== 'deveco')
      .sort((a, b) => (PROVIDER_PRIORITY[a.id] ?? 99) - (PROVIDER_PRIORITY[b.id] ?? 99));
  });

  const filteredProviders = createMemo(() => {
    const q = providerQuery().toLowerCase().trim();
    const list = providerList();
    if (!q) {
      return list;
    }
    return list.filter(
      (p) =>
        providerLabel(p.id, p.name).toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q),
    );
  });

  createEffect(() => {
    const list = filteredProviders();
    const idx = providerIndex();
    if (list.length === 0) {
      setProviderIndex(0);
      return;
    }
    if (idx >= list.length) {
      setProviderIndex(list.length - 1);
    }
  });

  const dimensions = useTerminalDimensions();
  const providerScrollHeight = createMemo(() => {
    const slot = props.bodySlotHeight ?? Math.floor(dimensions().height / 2) - 12;
    const overhead = 8;
    const maxFromSlot = Math.max(3, slot - overhead);
    const maxHeight = Math.floor(dimensions().height / 2) - 12;
    const cap = Math.min(maxFromSlot, maxHeight);
    return Math.min(filteredProviders().length, Math.max(cap, 5));
  });

  /** Fixed height (rows) for the top content zone across all onboarding pages.
   *  Keeps numbered options at the same vertical position on every page. */
  const TOP_ZONE_HEIGHT = 8;


  const providerSearchBoxWidth = createMemo(() => {
    const termW = Math.floor(dimensions().width);
    const pad = homeContentPadX(termW);
    const w = termW - BANNER_HOME_CONTENT_INSET - pad * 2;
    return Math.max(16, Math.min(75, w));
  });

  const fitText = (s: string, w: number) => {
    if (w <= 0) {
      return '';
    }
    if (s.length === w) {
      return s;
    }
    if (s.length < w) {
      return s + ' '.repeat(w - s.length);
    }
    return s.slice(0, w);
  };

  const scrollToProvider = (index: number) => {
    if (!providerScroll) {
      return;
    }
    const children = providerScroll.getChildren();
    const target = children[index];
    if (!target) {
      return;
    }
    const y = target.y - providerScroll.y;
    if (y >= providerScroll.height) {
      providerScroll.scrollBy(y - providerScroll.height + 1);
    }
    if (y < 0) {
      providerScroll.scrollBy(y);
      if (index === 0) {
        providerScroll.scrollTo(0);
      }
    }
  };

  const runBrowserLogin = async () => {
    setAuthBusy(true);
    setAuthMessage(null);
    authAborted = false;
    try {
      const result = await devecoAuth.login();
      if (authAborted) {
        // Escape handler already reset authBusy/step, nothing more to do
        return;
      }
      if (!result.success) {
        if (result.cancelled) {
          setStep(authReturnStep);
          setAuthBusy(false);
          return;
        }
        // Login failed (e.g. network error, port conflict) → surface the error on
        // whichever page we return to and let the user retry
        if (authReturnStep === 'realname') {
          setRealnameRecheckError(result.error ?? t("account.login_failed"));
        } else {
            setAuthMessage(result.error ?? t("account.login_failed"));
        }
        setStep(authReturnStep);
        setAuthBusy(false);
        return;
      }
      const access = result.userInfo?.accessToken || '';
      const refresh = result.userInfo?.refreshToken || '';
      await saveAuthToDisk('deveco', {
        type: 'oauth',
        access,
        refresh,
        expires: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
        isRealName: result.userInfo?.isRealName ?? false,
      });
      const { trySyncAgreement } = await import('@/cli/deveco-agreement-sync');
      await trySyncAgreement();
      const { getDevecoProviderConfig, clearDevecoModelCache } = await import('@/plugin/deveco-models');
      clearDevecoModelCache();
      await getDevecoProviderConfig(access);
      await sdk.client.instance.dispose();
      await sync.bootstrap();
      setAuthBusy(false);
      // Check real-name verification status
      if (result.userInfo && !result.userInfo.isRealName) {
        if (authReturnStep === 'realname') {
          toast.show({ variant: 'warning', message: t("account.realname_incomplete"), duration: 3000 });
        }
        logWarn("login succeeded but real-name verification not completed, blocking entry", { service: "deveco" });
        setStep('realname');
        return;
      }
      // If DEVECO_HOME is not configured, prompt for it before agreement
      if (!(await hasConfiguredDevEcoHome())) {
        setStep('deveco-home');
        void runDevEcoHomeDetection();
        return;
      }
      // Otherwise → jump to privacy step for agreement check
      setStep('privacy');
      void checkAgreementStatus();
    } catch (error) {
      if (authAborted) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : t("account.login_failed");
      setAuthMessage(errorMessage);
      setStep('entry');
      setAuthBusy(false);
    }
  };

  const apiKeyTitle = (providerId: string) => {
    const row = sync.data.provider_next.all.find((p) => p.id === providerId);
    const name = row ? providerLabel(row.id, row.name) : providerId;
    return t("account.provider_key", { name });
  };

  const submitKey = async (providerId: string, value: string) => {
    await sdk.client.auth.set({
      providerID: providerId,
      auth: { type: 'api', key: value },
    }, { throwOnError: true });
    await finishOnboarding(providerId).catch(() => {
      toast.show({ variant: 'error', message: t("account.key_setup_failed") });
    });
  };

  const finishOnboarding = async (providerId: string) => {
    setKeySubmitStatus(t("account.loading_models"));
    await sdk.client.instance.dispose();
    await sync.bootstrap();
    const provider = sync.data.provider.find((item) => item.id === providerId);
    const modelID = sync.data.provider_default[providerId] ?? Object.values(provider?.models ?? {})[0]?.id;
    if (!modelID) {
      toast.show({ variant: 'warning', message: t("account.model_config_required") });
      return;
    }
    setKeySubmitStatus(t("account.applying_model"));
    if (sync.data.config.model?.startsWith('deveco/')) {
      await sdk.client.config.update({ config: { model: `${providerId}/${modelID}` } }, { throwOnError: true });
    }
    local.model.set({ providerID: providerId, modelID }, { recent: true });
    props.onComplete();
  };

  const [keySubmitBusy, setKeySubmitBusy] = createSignal(false);
  const [keySubmitStatus, setKeySubmitStatus] = createSignal('');
  const trySubmitApiKey = () => {
    if (keySubmitBusy()) {
      return;
    }
    const id = pid();
    if (!id) {
      return;
    }
    const value = (input?.plainText ?? key()).trim();
    if (!value) {
      return;
    }
    setKeySubmitStatus(t("account.saving_key"));
    setKeySubmitBusy(true);
    void submitKey(id, value).catch(() => {
      toast.show({ variant: 'error', message: t("account.save_failed") });
    }).finally(() => setKeySubmitBusy(false));
  };

  const handleProviderSelect = async (providerId: string) => {
    const methods = sync.data.provider_auth[providerId] ?? DEFAULT_AUTH_METHODS;
    const methodIndex = await pickAuthMethodIndex(dialog, methods, t);
    if (methodIndex === null) {
      return;
    }

    const method = methods[methodIndex];
    if (method.type === 'api') {
      setPid(providerId);
      setKey('');
      setStep('key');
      return;
    }

    if (method.type === 'oauth') {
      await runProviderOAuth({ dialog, sdk, theme, t, finish: () => finishOnboarding(providerId) }, providerId, methodIndex, method);
    }
  };

  const appendFilterKey = (name: string): boolean => {
    if (name === 'space') {
      setProviderQuery((q) => `${q} `);
      return true;
    }
    if (name.length === 1 && /[a-z0-9._-]/i.test(name)) {
      setProviderQuery((q) => q + name);
      return true;
    }
    return false;
  };

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) {
      return;
    }

    const st = step();

    if (st === 'realname') {
      if (evt.name === 'escape') {
        evt.preventDefault();
        setStep('entry');
        return;
      }
      if (evt.ctrl && evt.name === 'c') {
        evt.preventDefault();
        void exit();
        return;
      }
      if (evt.name === 'up') {
        evt.preventDefault();
        setRealnameIndex(Math.max(0, realnameIndex() - 1));
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        setRealnameIndex(Math.min(2, realnameIndex() + 1));
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        if (realnameIndex() === 0) {
          // "Authenticate" — open real-name authentication page in browser
          logInfo("opening real-name authentication page in browser", { service: "deveco", url: HuaweiEndpoints.huaweiRealnameAuth });
          open(HuaweiEndpoints.huaweiRealnameAuth).catch((err) => {
            logError("failed to open real-name authentication page", { service: "deveco", error: err instanceof Error ? err.message : String(err) });
          });
        } else if (realnameIndex() === 1) {
          // "Re-check real-name" — re-login to refresh the JWT, reusing the auth waiting page
          setRealnameRecheckError(null);
          authReturnStep = 'realname';
          setStep('auth');
          void runBrowserLogin();
        } else {
          setStep('entry');
        }
      }
      return;
    }

    if (st === 'privacy' || st === 'product-privacy') {
      if (evt.name === 'escape' || (evt.ctrl && evt.name === 'c')) {
        evt.preventDefault();
        void exit();
      }
      return;
    }

if (st === 'entry') {
      if (evt.ctrl && evt.name === 'c') {
        evt.preventDefault();
        void exit();
        return;
      }
      if (evt.name === 'up') {
        evt.preventDefault();
        setEntryIndex(Math.max(0, entryIndex() - 1));
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        setEntryIndex(Math.min(1, entryIndex() + 1));
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        void chooseEntry();
        return;
      }
      return;
    }

    if (st === 'auth') {
      if (evt.ctrl && evt.name === 'c') {
        evt.preventDefault();
        void exit();
        return;
      }
      if (evt.name === 'escape') {
        evt.preventDefault();
        if (authBusy()) {
          authAborted = true;
          devecoAuth.cancel();
          setAuthBusy(false);
        }
        setStep(authReturnStep);
        return;
      }
      if (authBusy()) {
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        void runBrowserLogin();
      }
      return;
    }

    if (st === 'deveco-home') {
      if (evt.ctrl && evt.name === 'c') {
        evt.preventDefault();
        void exit();
        return;
      }
      // Custom path input mode
      if (devecoHomeInputMode()) {
        if (evt.name === 'escape') {
          evt.preventDefault();
          setDevecoHomeInputMode(false);
          setDevecoHomeError(null);
          return;
        }
        if (evt.name === 'return') {
          evt.preventDefault();
          void submitCustomDevEcoHome();
        }
        return;
      }
      // Candidate list navigation
      if (devecoHomeBusy()) return;
      const candidates = devecoHomeCandidates();
      // Total options: candidates + "Enter custom path" + "Skip"
      const totalOptions = candidates.length + 2;
      if (evt.name === 'up') {
        evt.preventDefault();
        setDevecoHomeIndex(Math.max(0, devecoHomeIndex() - 1));
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        setDevecoHomeIndex(Math.min(totalOptions - 1, devecoHomeIndex() + 1));
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        const idx = devecoHomeIndex();
        if (idx < candidates.length) {
          // Selected an auto-detected candidate
          void applyDevEcoHomeAndContinue(candidates[idx]);
        } else if (idx === candidates.length) {
          // "Enter a custom path"
          setDevecoHomeInputMode(true);
          setDevecoHomeError(null);
          setDevecoHomeInputValue('');
        } else {
          // "Skip"
          void applyDevEcoHomeAndContinue(undefined);
        }
      }
      return;
    }

    if (st === 'providers') {
      if (evt.ctrl && evt.name === 'c') {
        evt.preventDefault();
        void exit();
        return;
      }
      if (evt.name === 'escape') {
        evt.preventDefault();
        if (providerQuery().length > 0) {
          setProviderQuery('');
          setProviderIndex(0);
          return;
        }
        setStep('entry');
        return;
      }
      if (evt.name === 'backspace') {
        evt.preventDefault();
        if (providerQuery().length > 0) {
          setProviderQuery((q) => q.slice(0, -1));
          setProviderIndex(0);
        }
        return;
      }
      const list = filteredProviders();
      if (evt.name === 'up') {
        evt.preventDefault();
        const newIndex = Math.max(0, providerIndex() - 1);
        setProviderIndex(newIndex);
        scrollToProvider(newIndex);
        return;
      }
      if (evt.name === 'down') {
        evt.preventDefault();
        const newIndex = Math.min(Math.max(list.length - 1, 0), providerIndex() + 1);
        setProviderIndex(newIndex);
        scrollToProvider(newIndex);
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        const idx = providerIndex();
        const provider = list[idx];
        if (provider) {
          void handleProviderSelect(provider.id).catch(() => {
            toast.show({ variant: 'error', message: t("account.setup_failed") });
          });
        }
        return;
      }
      if (!evt.ctrl && !evt.meta && appendFilterKey(evt.name)) {
        evt.preventDefault();
        setProviderIndex(0);
        scrollToProvider(0);
      }
    }

    if (st === 'key') {
      if (keySubmitBusy()) {
        evt.preventDefault();
        if (evt.ctrl && evt.name === 'c') void exit();
        return;
      }
      if (evt.ctrl && evt.name === 'c') {
        if (key().length > 0) {
          evt.preventDefault();
          setKey('');
          input?.clear();
          return;
        }
        evt.preventDefault();
        void exit();
        return;
      }
      if (evt.name === 'escape') {
        evt.preventDefault();
        setStep('providers');
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        trySubmitApiKey();
      }
    }
  });

  return (
    <box
      flexDirection='column'
      gap={2}
      flexShrink={0}
      width='100%'
      alignItems='center'
      justifyContent='center'
    >
      <Show when={step() === 'privacy' || step() === 'product-privacy'}>
        <AgreementPanel maxHeight={props.bodySlotHeight} onComplete={() => step() === 'product-privacy' ? continueSetup() : props.onComplete()} />
      </Show>
      <Show when={step() === 'entry'}>
        <OnboardingContent>
            <text fg={theme.text} attributes={1} selectable={false} marginBottom={2}>
              {t("account.setup_title")}
            </text>
            <box flexDirection='column'>
              <text fg={entryIndex() === 0 ? theme.success : theme.text} selectable={false}>
                {selectionLead(entryIndex() === 0)}
                {t("account.entry_huawei")}
              </text>
              <text fg={entryIndex() === 1 ? theme.success : theme.text} selectable={false}>
                {selectionLead(entryIndex() === 1)}
                {t("account.entry_thirdparty")}
              </text>
            </box>
            <text fg={theme.textMuted} selectable={false} marginTop={1}>
              {t("account.setup_help")}
            </text>
            <Show when={authMessage() !== null}>
              <text fg={theme.error} selectable={false}>
                {authMessage()}
              </text>
            </Show>
        </OnboardingContent>
      </Show>
      <Show when={step() === 'auth'}>
        <OnboardingContent>
            <text fg={theme.text} selectable={false}>
              {t("account.signin")}
            </text>
            <text fg={theme.textMuted} selectable={false} marginTop={1}>
              {authBusy() ? t("account.browser_wait") : t("account.open_login")}
            </text>
            <Show when={authMessage() !== null}>
              <text fg={theme.error} selectable={false}>
                {authMessage()}
              </text>
            </Show>
            <Show when={authBusy()}>
              <text fg={theme.textMuted} selectable={false}>
                {t("account.esc_back")}
              </text>
            </Show>
        </OnboardingContent>
      </Show>
      <Show when={step() === 'deveco-home'}>
        <OnboardingContent>
          <Show when={devecoHomeBusy()}>
            <box flexDirection='column' alignItems='center'>
              <text fg={theme.textMuted} selectable={false}>
                {t("account.detect_studio")}
              </text>
            </box>
          </Show>
          <Show when={!devecoHomeBusy() && !devecoHomeInputMode()}>
            <text fg={theme.text} attributes={1} selectable={false} marginBottom={1}>
              {t("account.configure_studio")}
            </text>
            <box flexDirection='column'>
              <For each={devecoHomeCandidates()}>
                {(candidate, idx) => (
                  <text fg={devecoHomeIndex() === idx() ? theme.success : theme.text} selectable={false}>
                    {selectionLead(devecoHomeIndex() === idx())}
                    {idx() + 1}. {candidate}
                  </text>
                )}
              </For>
              <text
                fg={devecoHomeIndex() === devecoHomeCandidates().length ? theme.success : theme.text}
                selectable={false}
              >
                {selectionLead(devecoHomeIndex() === devecoHomeCandidates().length)}
                {devecoHomeCandidates().length + 1}. {t("account.custom_path")}
              </text>
              <text
                fg={devecoHomeIndex() === devecoHomeCandidates().length + 1 ? theme.success : theme.text}
                selectable={false}
              >
                {selectionLead(devecoHomeIndex() === devecoHomeCandidates().length + 1)}
                {devecoHomeCandidates().length + 2}. {t("account.skip_studio")}
              </text>
            </box>
            <text fg={theme.textMuted} selectable={false} marginTop={1}>
              {t("account.select_hint")}
            </text>
          </Show>
          <Show when={!devecoHomeBusy() && devecoHomeInputMode()}>
            <text fg={theme.text} attributes={1} selectable={false}>
              {t("account.studio_path")}
            </text>
            <box flexDirection='column' width={providerSearchBoxWidth()}>
              <text fg={theme.textMuted} selectable={false} wrapMode='none'>
                {`╭${'─'.repeat(Math.max(0, providerSearchBoxWidth() - 2))}╮`}
              </text>
              <box flexDirection='row' width={providerSearchBoxWidth()}>
                <text fg={theme.textMuted} selectable={false} wrapMode='none'>
                  │
                </text>
                <textarea
                  focused={true}
                  ref={(r: TextareaRenderable) => (devecoHomeInput = r)}
                  height={1}
                  width={Math.max(0, providerSearchBoxWidth() - 2)}
                  placeholder={t("account.studio_placeholder")}
                  textColor={theme.text}
                  focusedTextColor={theme.text}
                  cursorColor={theme.text}
                  onContentChange={() => setDevecoHomeInputValue(devecoHomeInput?.plainText ?? '')}
                  onSubmit={() => submitCustomDevEcoHome()}
                />
                <text fg={theme.textMuted} selectable={false} wrapMode='none'>
                  │
                </text>
              </box>
              <text fg={theme.textMuted} selectable={false} wrapMode='none'>
                {`╰${'─'.repeat(Math.max(0, providerSearchBoxWidth() - 2))}╯`}
              </text>
            </box>
            <Show when={devecoHomeError() !== null}>
              <text fg={theme.error} selectable={false} wrapMode='word'>
                {devecoHomeError()}
              </text>
            </Show>
            <text fg={theme.textMuted} selectable={false} marginTop={1}>
              {t("account.submit_hint")}
            </text>
          </Show>
        </OnboardingContent>
      </Show>
      <Show when={step() === 'realname'}>
        <OnboardingContent>
          <text fg={theme.warning} attributes={1} selectable={false} marginBottom={1}>
            {t("account.realname_required")}
          </text>
          <text fg={theme.text} selectable={false} wrapMode='word'>
            {t("account.realname_description")}
          </text>
          <Link
            href={HuaweiEndpoints.huaweiRealnameAuth}
            fg={theme.primary}
          >
            {t("account.realname_link")}
          </Link>
          <box flexDirection='column' marginTop={1}>
            <text fg={realnameIndex() === 0 ? theme.success : theme.text} selectable={false}>
              {selectionLead(realnameIndex() === 0)}
              {t("account.realname_go")}
            </text>
            <text fg={realnameIndex() === 1 ? theme.success : theme.text} selectable={false}>
              {selectionLead(realnameIndex() === 1)}
              {t("account.realname_recheck")}
            </text>
            <text fg={realnameIndex() === 2 ? theme.success : theme.text} selectable={false}>
              {selectionLead(realnameIndex() === 2)}
              {t("account.realname_back")}
            </text>
          </box>
          <text fg={theme.textMuted} selectable={false} marginTop={1}>
            {t("account.select_hint")}
          </text>
          <Show when={realnameRecheckError() !== null}>
            <text fg={theme.error} selectable={false}>
              {realnameRecheckError()}
            </text>
          </Show>
        </OnboardingContent>
      </Show>
      <Show when={step() === 'providers'}>
        <OnboardingContent>
            <text fg={theme.text} attributes={1} selectable={false}>
              {t("account.choose_provider")}
            </text>
            <box flexDirection='column' width={providerSearchBoxWidth()}>
              <text fg={theme.textMuted} selectable={false} wrapMode='none'>
                {`╭${'─'.repeat(Math.max(0, providerSearchBoxWidth() - 2))}╮`}
              </text>
              <text selectable={false} wrapMode='none'>
                <span style={{ fg: theme.textMuted }}>│</span>
                <span style={{ fg: providerQuery() ? theme.text : theme.textMuted }}>
                  {fitText(` ${providerQuery() || 'Search'}`, Math.max(0, providerSearchBoxWidth() - 2))}
                </span>
                <span style={{ fg: theme.textMuted }}>│</span>
              </text>
              <text fg={theme.textMuted} selectable={false} wrapMode='none'>
                {`╰${'─'.repeat(Math.max(0, providerSearchBoxWidth() - 2))}╯`}
              </text>
            </box>
            <scrollbox
              ref={(r: ScrollBoxRenderable) => (providerScroll = r)}
              maxHeight={providerScrollHeight()}
              scrollbarOptions={{ visible: false }}
            >
              <For each={filteredProviders()}>
                {(provider, idx) => (
                  <text fg={providerIndex() === idx() ? theme.success : theme.text} selectable={false}>
                    {selectionLead(providerIndex() === idx())}
                    {idx() + 1}. {providerLabel(provider.id, provider.name)}
                  </text>
                )}
              </For>
            </scrollbox>
            <text fg={theme.textMuted} selectable={false} marginTop={1}>
              {t("account.provider_hint")}
            </text>
        </OnboardingContent>
      </Show>
      <Show when={step() === 'key'}>
        <OnboardingContent>
            <text fg={theme.text} attributes={1} selectable={false}>
              {pid() ? apiKeyTitle(pid()!) : t("account.enter_key")}
            </text>
            <box
              width={providerSearchBoxWidth()}
              border={true}
              borderStyle='rounded'
              borderColor={theme.textMuted}
              paddingLeft={1}
              paddingRight={1}
            >
              <textarea
                focused={!keySubmitBusy()}
                ref={(r: TextareaRenderable) => (input = r)}
                width='100%'
                minHeight={1}
                maxHeight={4}
                wrapMode='char'
                keyBindings={[
                  { name: 'home', action: 'buffer-home' },
                  { name: 'end', action: 'buffer-end' },
                ]}
                placeholder={t("account.paste_key")}
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.text}
                onContentChange={() => setKey(input?.plainText ?? '')}
                onSubmit={() => trySubmitApiKey()}
              />
            </box>
            <Show
              when={keySubmitBusy()}
              fallback={
                <text fg={theme.textMuted} selectable={false} marginTop={1}>
                  {t("account.key_hint")}
                </text>
              }
            >
              <box flexDirection='column' alignItems='center' width='100%' gap={1} marginTop={1}>
                <Spinner>{keySubmitStatus()}</Spinner>
                <text fg={theme.textMuted} selectable={false}>{t("account.wait_exit")}</text>
              </box>
            </Show>
        </OnboardingContent>
      </Show>
    </box>
  );
}
