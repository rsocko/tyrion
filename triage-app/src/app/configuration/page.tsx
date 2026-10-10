"use client";

import Link from "next/link";
import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AccountDefaultModeV1,
  AttributionConfidenceV1,
  ExceptionSignalV1,
  KidProfileV1,
  LimitPeriodV1,
  MerchantRuleOutcomeV1,
  MerchantRuleScopeV1,
  PolicyDraftV1,
  PolicySnapshotV1,
} from "@rsocko/tyrion-kid-engine/contracts/v2";
import {
  AccountCatalogError,
  loadAccountCatalog,
  type AccountCatalogItem,
} from "@/lib/account-catalog-client";
import {
  PolicyApiError,
  applyReattribution,
  loadPolicy,
  previewReattribution,
  savePolicy,
  type PolicyCapabilities,
  type ReattributionPreviewSummary,
} from "@/lib/policy-client";
import {
  policyStatePresentation,
  type PolicyUiState,
} from "@/lib/policy-ui-state.mjs";

type LoadState = "loading" | "ready" | "unauthorized" | "unavailable";
type CatalogState = "loading" | "ready" | "error";
type BusyState = "saving" | "previewing" | "applying" | null;
type RuleConfidence = Exclude<AttributionConfidenceV1, "none">;

const PERIODS: LimitPeriodV1[] = ["daily", "weekly", "monthly"];
const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")].map(
  (timezone) => ({ value: timezone, label: timezone })
);
const CURRENCIES = Intl.supportedValuesOf("currency").map((currency) => ({
  value: currency,
  label: currency,
}));
const SIGNALS: Array<{ value: ExceptionSignalV1; label: string }> = [
  { value: "limit-warning", label: "Limit warning" },
  { value: "limit-exceeded", label: "Limit exceeded" },
  { value: "attribution-review", label: "Attribution needs review" },
  { value: "connector-degraded", label: "Connector degraded" },
];

export default function ConfigurationPage() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [mode, setMode] = useState<"demo" | "production">("production");
  const [policy, setPolicy] = useState<PolicySnapshotV1 | null>(null);
  const [draft, setDraft] = useState<PolicyDraftV1 | null>(null);
  const [accounts, setAccounts] = useState<AccountCatalogItem[]>([]);
  const [catalogState, setCatalogState] = useState<CatalogState>("loading");
  const [catalogError, setCatalogError] = useState("");
  const [capabilities, setCapabilities] = useState<PolicyCapabilities>({
    write: false,
    previewReattribution: false,
    applyReattribution: false,
  });
  const [busy, setBusy] = useState<BusyState>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [newKidName, setNewKidName] = useState("");
  const [newMerchantKid, setNewMerchantKid] = useState("");
  const [newMerchantPattern, setNewMerchantPattern] = useState("");
  const [newMerchantBusinessEntity, setNewMerchantBusinessEntity] = useState("");
  const [newMerchantOutcome, setNewMerchantOutcome] =
    useState<MerchantRuleOutcomeV1>("kid");
  const [newMerchantScope, setNewMerchantScope] =
    useState<MerchantRuleScopeV1>("accounts");
  const [newMerchantAccounts, setNewMerchantAccounts] = useState<string[]>([]);
  const [newMerchantConfidence, setNewMerchantConfidence] =
    useState<RuleConfidence>("likely");
  const [sourceRefs, setSourceRefs] = useState("");
  const [preview, setPreview] = useState<ReattributionPreviewSummary | null>(null);
  const [applyConfirmed, setApplyConfirmed] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);

  const refreshCatalog = useCallback(async () => {
    setCatalogState("loading");
    setCatalogError("");
    try {
      setAccounts(await loadAccountCatalog());
      setCatalogState("ready");
    } catch (caught) {
      const message =
        caught instanceof AccountCatalogError
          ? caught.message
          : "Accounts could not be loaded";
      setCatalogError(message);
      setCatalogState("error");
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.resolve();
    setLoadState("loading");
    setError("");
    setConflict(false);
    try {
      const [result] = await Promise.all([
        loadPolicy(),
        refreshCatalog(),
      ]);
      setMode(result.mode);
      setPolicy(result.policy);
      setDraft(result.draft);
      setCapabilities(result.capabilities);
      setNewMerchantKid(result.draft.kids[0]?.id ?? "");
      setNewMerchantAccounts([]);
      setPreview(null);
      setApplyConfirmed(false);
      setLoadState("ready");
    } catch (caught) {
      const apiError = toApiError(caught);
      setError(apiError.message);
      setLoadState(apiError.status === 401 ? "unauthorized" : "unavailable");
    }
  }, [refreshCatalog]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeout);
  }, [refresh]);

  useEffect(() => {
    if (error || conflict) alertRef.current?.focus();
  }, [conflict, error]);

  const replaceDraft = (next: PolicyDraftV1) => {
    setDraft(next);
    setNotice("");
    setPreview(null);
    setApplyConfirmed(false);
  };

  const handleSave = async () => {
    if (!draft) return;
    setBusy("saving");
    setError("");
    setNotice("");
    setConflict(false);
    try {
      const result = await savePolicy(policy?.policyVersion ?? null, draft);
      setPolicy(result.policy);
      setDraft(snapshotDraft(result.policy));
      setNotice(`Policy version ${result.policy.policyVersion} saved.`);
    } catch (caught) {
      const apiError = toApiError(caught);
      if (apiError.status === 409) setConflict(true);
      setError(apiError.message);
    } finally {
      setBusy(null);
    }
  };

  const addKid = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !newKidName.trim()) return;
    const kid: KidProfileV1 = {
      id: `kid-${crypto.randomUUID()}`,
      displayName: newKidName.trim(),
      color: null,
      active: true,
    };
    replaceDraft({ ...draft, kids: [...draft.kids, kid] });
    setNewKidName("");
    setNewMerchantKid((current) => current || kid.id);
  };

  const removeKid = (kidId: string) => {
    if (!draft) return;
    replaceDraft({
      ...draft,
      kids: draft.kids.filter((kid) => kid.id !== kidId),
      accountDefaults: draft.accountDefaults.map((accountDefault) =>
        accountDefault.kidId === kidId
          ? { ...accountDefault, mode: "rule-based", kidId: null }
          : accountDefault
      ),
      merchantRules: draft.merchantRules.filter(
        (rule) => rule.outcome !== "kid" || rule.kidId !== kidId
      ),
      limits: draft.limits.filter((limit) => limit.kidId !== kidId),
    });
  };

  const setAccountDefault = (
    accountRef: string,
    value: string
  ) => {
    if (!draft) return;
    const mode: AccountDefaultModeV1 =
      value === "parent-shared"
        ? "parent-shared"
        : value.startsWith("child:")
          ? "child"
          : "rule-based";
    const kidId = mode === "child" ? value.slice("child:".length) : null;
    replaceDraft({
      ...draft,
      accountDefaults: [
        ...draft.accountDefaults.filter(
          (accountDefault) => accountDefault.accountRef !== accountRef
        ),
        { accountRef, mode, kidId },
      ],
    });
  };

  const addMerchantRule = (event: FormEvent) => {
    event.preventDefault();
    if (
      !draft ||
      !newMerchantPattern.trim() ||
      (newMerchantOutcome === "kid" && !newMerchantKid) ||
      (newMerchantScope === "accounts" && newMerchantAccounts.length === 0)
    ) {
      return;
    }
    replaceDraft({
      ...draft,
      merchantRules: [
        ...draft.merchantRules,
        {
          id: `rule-merchant-${crypto.randomUUID()}`,
          outcome: newMerchantOutcome,
          kidId: newMerchantOutcome === "kid" ? newMerchantKid : null,
          pattern: newMerchantPattern.trim(),
          businessEntityPattern:
            newMerchantBusinessEntity.trim() || null,
          scope: newMerchantScope,
          accountRefs:
            newMerchantScope === "accounts" ? newMerchantAccounts : [],
          confidence: newMerchantConfidence,
          enabled: true,
        },
      ],
    });
    setNewMerchantPattern("");
    setNewMerchantBusinessEntity("");
  };

  const toggleMerchantAccount = (accountRef: string, selected: boolean) => {
    setNewMerchantAccounts((current) =>
      selected
        ? Array.from(new Set([...current, accountRef]))
        : current.filter((item) => item !== accountRef)
    );
  };

  const setLimit = (
    kidId: string,
    period: LimitPeriodV1,
    amountValue: string
  ) => {
    if (!draft) return;
    const amount = Number(amountValue);
    const remaining = draft.limits.filter(
      (limit) => !(limit.kidId === kidId && limit.period === period)
    );
    replaceDraft({
      ...draft,
      limits:
        amountValue === "" || !Number.isFinite(amount) || amount < 0
          ? remaining
          : [...remaining, { kidId, period, amount, currency: draft.currency }],
    });
  };

  const handlePreview = async () => {
    if (!policy) return;
    const refs = Array.from(
      new Set(sourceRefs.split(/\r?\n/).map((item) => item.trim()))
    ).filter(Boolean);
    setBusy("previewing");
    setError("");
    setNotice("");
    setApplyConfirmed(false);
    try {
      const result = await previewReattribution(policy.policyVersion, refs);
      setPreview(result.preview);
      setNotice(
        `Preview created for ${result.preview.selectedCount} opaque record references.`
      );
    } catch (caught) {
      const apiError = toApiError(caught);
      if (apiError.status === 409) setConflict(true);
      setError(apiError.message);
      setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const handleApply = async () => {
    if (!preview || !applyConfirmed) return;
    setBusy("applying");
    setError("");
    setNotice("");
    try {
      const { result } = await applyReattribution(
        preview.previewId,
        preview.policyVersion
      );
      setNotice(
        `Applied ${result.applied}; preserved ${result.manualPreserved} manual decisions; ${result.pendingReview} require review.`
      );
      setPreview(null);
      setApplyConfirmed(false);
      setSourceRefs("");
    } catch (caught) {
      const apiError = toApiError(caught);
      if (apiError.status === 409) setConflict(true);
      setError(apiError.message);
    } finally {
      setBusy(null);
    }
  };

  if (loadState !== "ready" || !draft) {
    const unavailableState =
      loadState === "unauthorized" ? "unauthenticated" : loadState;
    const presentation = policyStatePresentation(unavailableState);
    return (
      <ConfigurationShell>
        <section className="rounded-xl border border-border bg-card p-6" aria-live="polite">
          <h1 className="font-serif text-3xl font-bold text-parchment">
            Household policy
          </h1>
          {loadState === "loading" ? (
            <p className="mt-4 text-muted">{presentation.description}</p>
          ) : (
            <>
              <h2 className="mt-6 text-lg font-semibold">
                {presentation.label}
              </h2>
              <p role="alert" className="mt-2 text-sm text-error">
                {error}
              </p>
              <button className="button-secondary mt-5" type="button" onClick={() => void refresh()}>
                Recheck
              </button>
            </>
          )}
        </section>
      </ConfigurationShell>
    );
  }

  const disabled = busy !== null || !capabilities.write;
  const workflowState: PolicyUiState = conflict
    ? "conflict"
    : error
      ? "failure"
      : busy === "previewing"
        ? "previewing"
        : busy === "applying"
          ? "applying"
          : busy
            ? "saving"
            : notice
              ? "success"
              : policy
                ? "ready"
                : "empty";
  const workflowPresentation = policyStatePresentation(workflowState);
  const catalogAccountRefs = new Set(accounts.map((account) => account.accountRef));
  const accountRows = [
    ...accounts.map((account) => ({ ...account, missing: false })),
    ...draft.accountDefaults
      .filter((accountDefault) => !catalogAccountRefs.has(accountDefault.accountRef))
      .map((accountDefault) => ({
        accountRef: accountDefault.accountRef,
        displayName: "Account no longer in catalog",
        type: "Unavailable",
        maskHint: null,
        isActive: false,
        missing: true,
      })),
  ];

  return (
    <ConfigurationShell>
      <header className="mb-8 border-b border-hair pb-6">
        <div className="flex flex-wrap items-center gap-3">
          <p className="eyebrow">Tyrion configuration</p>
          <span className="rounded border border-border bg-elevated px-2 py-1 text-xs text-muted">
            {mode} mode
          </span>
          <span className="rounded border border-border bg-elevated px-2 py-1 text-xs text-muted">
            {policy ? `policy v${policy.policyVersion}` : "not saved"}
          </span>
          <span className="rounded border border-border bg-elevated px-2 py-1 text-xs text-muted">
            {workflowPresentation.label}
          </span>
        </div>
        <h1 className="mt-2 font-serif text-3xl font-bold text-parchment sm:text-4xl">
          Household money policy
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
          Configure household attribution and exception policy. Mission Control
          remains the place for daily insights and review; Monarch remains the
          financial system of record.
        </p>
      </header>

      {(error || conflict) && (
        <div
          ref={alertRef}
          tabIndex={-1}
          role="alert"
          className="mb-6 rounded-lg border border-error bg-card p-4 text-sm text-error"
        >
          <p>{error}</p>
          {conflict && (
            <button className="button-secondary mt-3" type="button" onClick={() => void refresh()}>
              Reload current policy
            </button>
          )}
        </div>
      )}
      {notice && (
        <p aria-live="polite" className="mb-6 rounded-lg border border-success bg-card p-4 text-sm text-success">
          {notice}
        </p>
      )}

      {!capabilities.write && (
        <p className="mb-6 rounded-lg border border-warning bg-card p-4 text-sm text-warning">
          You have read-only policy access. Editing controls are disabled.
        </p>
      )}

      <Section title="Policy basics" description="Timezone and currency apply to every configured limit.">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="timezone"
            label="IANA timezone"
            value={draft.timezone}
            options={TIMEZONES}
            disabled={disabled}
            onChange={(timezone) => replaceDraft({ ...draft, timezone })}
          />
          <SelectField
            id="currency"
            label="ISO currency"
            value={draft.currency}
            options={CURRENCIES}
            disabled={disabled}
            onChange={(currency) =>
              replaceDraft({
                ...draft,
                currency,
                limits: draft.limits.map((limit) => ({
                  ...limit,
                  currency,
                })),
              })
            }
          />
        </div>
      </Section>

      <Section title="Kid profiles" description="Profiles are household policy subjects, not copies of Monarch users.">
        <div className="space-y-3">
          {draft.kids.length === 0 && <EmptyText>No kid profiles configured.</EmptyText>}
          {draft.kids.map((kid) => (
            <div key={kid.id} className="grid gap-3 rounded-lg border border-border bg-background p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <TextField
                id={`kid-name-${kid.id}`}
                label="Display name"
                value={kid.displayName}
                disabled={disabled}
                onChange={(displayName) =>
                  replaceDraft({
                    ...draft,
                    kids: draft.kids.map((item) =>
                      item.id === kid.id ? { ...item, displayName } : item
                    ),
                  })
                }
              />
              <label className="flex min-h-10 items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={kid.active}
                  disabled={disabled}
                  onChange={(event) =>
                    replaceDraft({
                      ...draft,
                      kids: draft.kids.map((item) =>
                        item.id === kid.id
                          ? { ...item, active: event.target.checked }
                          : item
                      ),
                      accountDefaults: event.target.checked
                        ? draft.accountDefaults
                        : draft.accountDefaults.map((accountDefault) =>
                            accountDefault.kidId === kid.id
                              ? {
                                  ...accountDefault,
                                  mode: "rule-based",
                                  kidId: null,
                                }
                              : accountDefault
                          ),
                    })
                  }
                />
                Active
              </label>
              <button className="button-danger" type="button" disabled={disabled} onClick={() => removeKid(kid.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <form onSubmit={addKid} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <TextField
            id="new-kid-name"
            label="New profile display name"
            value={newKidName}
            disabled={disabled}
            onChange={setNewKidName}
          />
          <button className="button-secondary" type="submit" disabled={disabled || !newKidName.trim()}>
            Add profile
          </button>
        </form>
      </Section>

      <Section
        title="Account defaults"
        description="Choose the fallback attribution for each Monarch account. Manual decisions and specific merchant rules always take precedence."
      >
        {catalogState === "loading" && (
          <p aria-live="polite" className="text-sm text-muted">Loading Monarch accounts...</p>
        )}
        {catalogState === "error" && (
          <div role="alert" className="rounded-lg border border-error bg-background p-4">
            <p className="text-sm text-error">{catalogError}</p>
            <button className="button-secondary mt-3" type="button" onClick={() => void refreshCatalog()}>
              Retry account catalog
            </button>
          </div>
        )}
        {catalogState === "ready" && accountRows.length === 0 && (
          <EmptyText>No Monarch accounts are available. Recheck the connector, then retry.</EmptyText>
        )}
        {catalogState === "ready" && accountRows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
              <thead className="bg-elevated text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Account</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Default attribution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {accountRows.map((account) => {
                  const accountDefault = draft.accountDefaults.find(
                    (item) => item.accountRef === account.accountRef
                  );
                  const value =
                    accountDefault?.mode === "child"
                      ? `child:${accountDefault.kidId}`
                      : accountDefault?.mode ?? "rule-based";
                  return (
                    <tr key={account.accountRef} className="bg-background align-top">
                      <td className="px-4 py-4">
                        <p className="font-medium text-parchment">{account.displayName}</p>
                        <p className="mt-1 text-xs text-muted">
                          {account.missing
                            ? "Configured default is preserved but no current catalog account matches it"
                            : `${account.maskHint ?? "No account hint"} · ${account.isActive ? "Active" : "Inactive"}`}
                        </p>
                      </td>
                      <td className="px-4 py-4 text-muted">{account.type}</td>
                      <td className="px-4 py-4">
                        <label className="sr-only" htmlFor={`account-default-${account.accountRef}`}>
                          Default attribution for {account.displayName}
                        </label>
                        <select
                          id={`account-default-${account.accountRef}`}
                          className="input w-full"
                          value={value}
                          disabled={disabled || account.missing}
                          onChange={(event) =>
                            setAccountDefault(account.accountRef, event.target.value)
                          }
                        >
                          <option value="rule-based">Rule-based</option>
                          <option value="parent-shared">Parent/shared</option>
                          {draft.kids
                            .filter((kid) => kid.active)
                            .map((kid) => (
                              <option key={kid.id} value={`child:${kid.id}`}>
                                {kid.displayName}
                              </option>
                            ))}
                        </select>
                        <p className="mt-2 max-w-md text-xs leading-5 text-muted">
                          {accountDefaultDescription(value, draft)}
                        </p>
                        {account.missing && (
                          <button
                            className="button-danger mt-3"
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                              replaceDraft({
                                ...draft,
                                accountDefaults: draft.accountDefaults.filter(
                                  (item) => item.accountRef !== account.accountRef
                                ),
                              })
                            }
                          >
                            Remove stale default
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Merchant attribution" description="Combine merchant, business entity, and account context to create deterministic household attribution rules.">
        <div className="mb-5 rounded-lg bg-background p-4 text-sm leading-6 text-muted">
          <p className="font-medium text-parchment">How overrides work</p>
          <p className="mt-1">
            Account-scoped rules override global rules for the same transaction.
            Equally specific rules that disagree are sent to review instead of choosing
            silently. Manual transaction decisions always remain highest priority.
          </p>
        </div>
        <div className="space-y-3">
          {draft.merchantRules.length === 0 && (
            <EmptyText>
              No merchant rules yet. Add an account-scoped rule for the safest starting
              point, or choose all accounts when the merchant is consistently attributable.
            </EmptyText>
          )}
          {draft.merchantRules.map((rule) => (
            <RuleRow
              key={rule.id}
              title={`${merchantOutcomeLabel(rule.outcome, rule.kidId, draft)} · ${rule.pattern}`}
              detail={merchantRuleDescription(rule, accounts)}
              enabled={rule.enabled}
              disabled={disabled}
              onToggle={(enabled) =>
                replaceDraft({
                  ...draft,
                  merchantRules: draft.merchantRules.map((item) =>
                    item.id === rule.id ? { ...item, enabled } : item
                  ),
                })
              }
              onRemove={() =>
                replaceDraft({
                  ...draft,
                  merchantRules: draft.merchantRules.filter((item) => item.id !== rule.id),
                })
              }
            />
          ))}
        </div>
        <form onSubmit={addMerchantRule} className="mt-5 grid gap-4 sm:grid-cols-2">
          <SelectField
            id="merchant-outcome"
            label="When the rule matches"
            value={newMerchantOutcome}
            disabled={disabled}
            onChange={(value) => setNewMerchantOutcome(readMerchantOutcome(value))}
            options={[
              { value: "kid", label: "Attribute to a profile" },
              { value: "parent-shared", label: "Classify as parent/shared" },
              { value: "review", label: "Leave unassigned for review" },
            ]}
          />
          {newMerchantOutcome === "kid" ? (
            <SelectField
              id="merchant-kid"
              label="Profile"
              value={newMerchantKid}
              disabled={disabled}
              onChange={setNewMerchantKid}
              options={draft.kids
                .filter((kid) => kid.active)
                .map((kid) => ({ value: kid.id, label: kid.displayName }))}
            />
          ) : (
            <div className="hidden sm:block" aria-hidden="true" />
          )}
          <TextField
            id="merchant-pattern"
            label="Merchant name contains"
            value={newMerchantPattern}
            disabled={disabled}
            maxLength={160}
            onChange={setNewMerchantPattern}
          />
          <div>
            <TextField
              id="merchant-business-entity"
              label="Business entity contains (optional)"
              value={newMerchantBusinessEntity}
              disabled={disabled}
              maxLength={160}
              onChange={setNewMerchantBusinessEntity}
            />
            <p className="mt-2 text-xs leading-5 text-muted">
              Use this only when Monarch supplies a stable business-entity label that
              distinguishes otherwise similar merchant names.
            </p>
          </div>
          <SelectField
            id="merchant-scope"
            label="Applies to"
            value={newMerchantScope}
            disabled={disabled}
            onChange={(value) => setNewMerchantScope(readMerchantScope(value))}
            options={[
              { value: "accounts", label: "Selected accounts" },
              { value: "global", label: "All accounts" },
            ]}
          />
          <SelectField
            id="merchant-confidence"
            label="Confidence"
            value={newMerchantConfidence}
            disabled={disabled}
            onChange={(value) => setNewMerchantConfidence(readConfidence(value))}
            options={[
              { value: "definite", label: "Definite — apply automatically" },
              { value: "likely", label: "Likely — follow review policy" },
            ]}
          />
          {newMerchantScope === "accounts" && (
            <fieldset className="sm:col-span-2">
              <legend className="text-sm text-muted">Accounts</legend>
              {catalogState === "ready" && accounts.length > 0 ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {accounts
                    .filter((account) => account.isActive)
                    .map((account) => (
                      <label
                        key={account.accountRef}
                        className="flex min-h-11 items-center gap-3 rounded-md bg-elevated px-3 py-2 text-sm text-parchment"
                      >
                        <input
                          type="checkbox"
                          checked={newMerchantAccounts.includes(account.accountRef)}
                          disabled={disabled}
                          onChange={(event) =>
                            toggleMerchantAccount(
                              account.accountRef,
                              event.target.checked
                            )
                          }
                        />
                        <span>
                          {account.displayName}
                          {account.maskHint ? ` · ${account.maskHint}` : ""}
                        </span>
                      </label>
                    ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted">
                  Accounts must be available before adding an account-scoped rule.
                </p>
              )}
            </fieldset>
          )}
          <div className="sm:col-span-2">
            <button
              className="button-secondary"
              type="submit"
              disabled={
                disabled ||
                newMerchantPattern.trim().length < 2 ||
                (newMerchantOutcome === "kid" && !newMerchantKid) ||
                (newMerchantScope === "accounts" &&
                  newMerchantAccounts.length === 0)
              }
            >
              Add merchant rule
            </button>
          </div>
        </form>
      </Section>

      <Section title="Household limits" description="Set optional daily, weekly, and monthly amounts for each active profile.">
        {draft.kids.length === 0 ? (
          <EmptyText>Add a profile before configuring limits.</EmptyText>
        ) : (
          <div className="space-y-4">
            {draft.kids.map((kid) => (
              <fieldset key={kid.id} className="rounded-lg border border-border bg-background p-4">
                <legend className="px-1 font-semibold">{kid.displayName}</legend>
                <div className="grid gap-3 sm:grid-cols-3">
                  {PERIODS.map((period) => (
                    <TextField
                      key={period}
                      id={`limit-${kid.id}-${period}`}
                      label={`${capitalize(period)} (${draft.currency || "currency"})`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={String(
                        draft.limits.find(
                          (limit) => limit.kidId === kid.id && limit.period === period
                        )?.amount ?? ""
                      )}
                      disabled={disabled}
                      onChange={(value) => setLimit(kid.id, period, value)}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )}
      </Section>

      <Section title="Exception and notification policy" description="Choose which deterministic exception signals Tyrion makes eligible for Mission Control notification.">
        <TextField
          id="warning-percent"
          label="Limit warning percentage"
          type="number"
          min="1"
          max="100"
          value={String(draft.exceptionPolicy.limitWarningPercent)}
          disabled={disabled}
          onChange={(value) =>
            replaceDraft({
              ...draft,
              exceptionPolicy: {
                ...draft.exceptionPolicy,
                limitWarningPercent: Number(value),
              },
            })
          }
        />
        <label className="mt-4 flex items-start gap-3 text-sm text-muted">
          <input
            className="mt-1"
            type="checkbox"
            checked={draft.exceptionPolicy.requireReviewForLikelyAttribution}
            disabled={disabled}
            onChange={(event) =>
              replaceDraft({
                ...draft,
                exceptionPolicy: {
                  ...draft.exceptionPolicy,
                  requireReviewForLikelyAttribution: event.target.checked,
                },
              })
            }
          />
          Require review for likely-confidence attribution
        </label>
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Notification-eligible signals</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {SIGNALS.map((signal) => (
              <label key={signal.value} className="flex items-center gap-2 rounded border border-border bg-background p-3 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={draft.exceptionPolicy.notificationSignals.includes(signal.value)}
                  disabled={disabled}
                  onChange={(event) =>
                    replaceDraft({
                      ...draft,
                      exceptionPolicy: {
                        ...draft.exceptionPolicy,
                        notificationSignals: event.target.checked
                          ? [...draft.exceptionPolicy.notificationSignals, signal.value]
                          : draft.exceptionPolicy.notificationSignals.filter(
                              (item) => item !== signal.value
                            ),
                      },
                    })
                  }
                />
                {signal.label}
              </label>
            ))}
          </div>
        </fieldset>
      </Section>

      <div className="sticky bottom-3 z-10 mb-8 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold-deep bg-elevated p-4 shadow-xl">
        <p className="text-sm text-muted">
          {policy ? `Saving requires policy version ${policy.policyVersion}.` : "This creates policy version 1."}
        </p>
        <button className="button-primary" type="button" disabled={disabled} onClick={() => void handleSave()}>
          {busy === "saving" ? "Saving..." : "Save policy"}
        </button>
      </div>

      <Section title="Controlled re-attribution" description="Preview an explicit bounded set of opaque record references. Only deterministic impact counts leave the server.">
        {!policy ? (
          <EmptyText>Save the policy before creating a preview.</EmptyText>
        ) : (
          <>
            <label className="block text-sm text-muted" htmlFor="source-refs">
              Opaque record references, one per line (maximum 100)
            </label>
            <textarea
              id="source-refs"
              rows={5}
              className="input mt-2 w-full font-mono text-sm"
              value={sourceRefs}
              disabled={busy !== null || !capabilities.previewReattribution}
              onChange={(event) => {
                setSourceRefs(event.target.value);
                setPreview(null);
                setApplyConfirmed(false);
              }}
            />
            <button
              className="button-secondary mt-3"
              type="button"
              disabled={busy !== null || !capabilities.previewReattribution || !sourceRefs.trim()}
              onClick={() => void handlePreview()}
            >
              {busy === "previewing" ? "Previewing..." : "Preview impact"}
            </button>
          </>
        )}
        {preview && (
          <div className="mt-5 rounded-lg border border-gold-deep bg-background p-4">
            <h3 className="font-semibold">Preview for policy v{preview.policyVersion}</h3>
            <p className="mt-1 text-xs text-muted">
              Expires {new Date(preview.expiresAt).toLocaleString()}
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Impact label="Would update" value={preview.summary["would-update"]} />
              <Impact label="Unchanged" value={preview.summary.unchanged} />
              <Impact label="Manual preserved" value={preview.summary["manual-preserved"]} />
              <Impact label="Needs review" value={preview.summary["pending-review"]} />
            </dl>
            <label className="mt-5 flex items-start gap-3 text-sm text-warning">
              <input
                className="mt-1"
                type="checkbox"
                checked={applyConfirmed}
                disabled={busy !== null || !capabilities.applyReattribution}
                onChange={(event) => setApplyConfirmed(event.target.checked)}
              />
              Confirm applying this exact unexpired preview. Newer manual decisions will be preserved.
            </label>
            <button
              className="button-primary mt-4"
              type="button"
              disabled={busy !== null || !capabilities.applyReattribution || !applyConfirmed}
              onClick={() => void handleApply()}
            >
              {busy === "applying" ? "Applying..." : "Apply preview"}
            </button>
          </div>
        )}
      </Section>
    </ConfigurationShell>
  );
}

function ConfigurationShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <nav aria-label="Tyrion operations" className="mb-6 flex gap-4 text-sm">
        <Link className="text-muted underline hover:text-parchment" href="/">
          Monarch connector
        </Link>
        <Link aria-current="page" className="text-gold-hi underline" href="/configuration">
          Household policy
        </Link>
      </nav>
      {children}
      <footer className="mt-8 border-t border-hair pt-4 text-xs leading-5 text-dim">
        The Monarch connector is independent and unofficial. It is not affiliated with,
        endorsed by, sponsored by, or supported by Monarch Money, Inc.
      </footer>
    </main>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const id = `section-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section aria-labelledby={id} className="mb-6 rounded-xl border border-border bg-card p-5 sm:p-6">
      <h2 id={id} className="text-xl font-semibold">{title}</h2>
      <p className="mb-5 mt-1 text-sm leading-6 text-muted">{description}</p>
      {children}
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  disabled,
  ...props
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "onChange">) {
  return (
    <label className="block w-full text-sm text-muted" htmlFor={id}>
      {label}
      <input
        {...props}
        id={id}
        className="input mt-2 w-full"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm text-muted" htmlFor={id}>
      {label}
      <select id={id} className="input mt-2 w-full" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select...</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function RuleRow({
  title,
  detail,
  enabled,
  disabled,
  onToggle,
  onRemove,
}: {
  title: string;
  detail: string;
  enabled: boolean;
  disabled: boolean;
  onToggle: (value: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-background p-4 sm:flex-row sm:items-center">
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted">{detail}</p>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={enabled} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} />
          Enabled
        </label>
        <button className="button-danger" type="button" disabled={disabled} onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}

function Impact({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border bg-card p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
    </div>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">{children}</p>;
}

function snapshotDraft(policy: PolicySnapshotV1): PolicyDraftV1 {
  return {
    timezone: policy.timezone,
    currency: policy.currency,
    kids: policy.kids,
    accountDefaults: policy.accountDefaults,
    merchantRules: policy.merchantRules,
    limits: policy.limits,
    exceptionPolicy: policy.exceptionPolicy,
  };
}

function kidName(draft: PolicyDraftV1, kidId: string): string {
  return draft.kids.find((kid) => kid.id === kidId)?.displayName ?? "Unknown profile";
}

function merchantOutcomeLabel(
  outcome: MerchantRuleOutcomeV1,
  kidId: string | null,
  draft: PolicyDraftV1
): string {
  if (outcome === "parent-shared") return "Parent/shared";
  if (outcome === "review") return "Review required";
  return kidId ? kidName(draft, kidId) : "Unknown profile";
}

function merchantRuleDescription(
  rule: PolicyDraftV1["merchantRules"][number],
  accounts: AccountCatalogItem[]
): string {
  const scope =
    rule.scope === "global"
      ? "All accounts"
      : rule.accountRefs
          .map(
            (accountRef) =>
              accounts.find((account) => account.accountRef === accountRef)
                ?.displayName ?? "Unavailable account"
          )
          .join(", ");
  const entity = rule.businessEntityPattern
    ? ` · business entity contains ${rule.businessEntityPattern}`
    : "";
  return `${scope}${entity} · ${capitalize(rule.confidence)} confidence`;
}

function accountDefaultDescription(
  value: string,
  draft: PolicyDraftV1
): string {
  if (value === "parent-shared") {
    return "Falls back to parent/shared with no attribution review.";
  }
  if (value.startsWith("child:")) {
    const kidId = value.slice("child:".length);
    return `Falls back to ${kidName(draft, kidId)} with definite confidence.`;
  }
  return "No account fallback. Unmatched transactions continue to history, then review.";
}

function capitalize(value: string): string {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function readConfidence(value: string): RuleConfidence {
  return value === "definite" ? "definite" : "likely";
}

function readMerchantOutcome(value: string): MerchantRuleOutcomeV1 {
  return value === "parent-shared" || value === "review" ? value : "kid";
}

function readMerchantScope(value: string): MerchantRuleScopeV1 {
  return value === "global" ? "global" : "accounts";
}

function toApiError(value: unknown): PolicyApiError {
  return value instanceof PolicyApiError
    ? value
    : new PolicyApiError(0, "policy_operation_failed", "Policy operation failed");
}
