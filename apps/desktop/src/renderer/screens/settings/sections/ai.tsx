/**
 * Settings → AI (DESIGN 7.10, 9 rule 7; AGENTS.md). The Features table first (Ask, Summaries, Drafts, Plans, Voice,
 * each with a provider and a model; Voice lists only speech-to-text providers), then hosted providers (Groq is the
 * default), then "On this Mac and custom". Each provider shows its status and where its key comes from, never a
 * character of it; Test is on every row; a key from the environment shows Remove disabled with the reason.
 * Privacy sits behind one disclosure, and the background switch, consent re-review and daily cap follow.
 */
import { Button } from '../../../ui/buttons-keys';
import { accountLabel } from '../../../ui/accountLabel';
import { Switch } from '../../../ui/controls';
import { ErrorLine } from '../../../ui/list';
import { ProviderTable, SettingRow } from '../../../ui/settings';
import { Text } from '../../../ui/surfaces';
import type { ProviderAction, ProviderId } from '../../../ui/props';
import { Anchor, Group, Row, Select } from '../parts';
import {
  aiNotices,
  type AiNotice,
  backgroundLine,
  CAP_OPTIONS,
  capNote,
  capSelection,
  capUsage,
  consentView,
  featureRows,
  hostedRows,
  HOW_MAIL_IS_USED,
  isLocalId,
  localRows,
  paidSwitch,
  withCurrent,
  formatTokens,
} from '../settings.model';
import type { SectionProps } from './types';

/** The controls a row's control query can land on, the same set the screen's deep-link focus uses. */
const ROW_CONTROLS =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), ' +
  '[role="switch"]:not([disabled]):not([aria-disabled="true"]), [tabindex="0"]';

/**
 * Where focus goes when the "Turn on for existing accounts" row unmounts under its pressed button
 * (DESIGN 11.2: it moves to the next row): the background switch that follows it, else the section's
 * first control.
 */
export function accountMailFocusTarget(
  root: { querySelector(selectors: string): Element | null } | null,
): HTMLElement | null {
  if (!root) return null;
  const next =
    root.querySelector('[data-setting-anchor="background"] [role="switch"]') ??
    root.querySelector(ROW_CONTROLS);
  return next && 'focus' in next ? (next as HTMLElement) : null;
}

/** Moves focus to the next row before the commit, but only when it is on this row — never a steal. */
function moveFocusOffAccountMail(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (!active.closest('[data-setting-anchor="accountMail"]')) return;
  accountMailFocusTarget(active.closest('.settings-content'))?.focus({ preventScroll: true });
}

/** One neutral setup line (never red: nothing failed), with Add key when a key is what is missing. */
function AiNoticeLine({
  notice,
  onAddKey,
}: {
  readonly notice: AiNotice;
  readonly onAddKey: (provider: string) => void;
}) {
  const provider = notice.addKeyFor;
  return (
    <div className="settings-notice" role="status">
      <Text variant="small" tone="ink-2">
        {notice.text}
      </Text>
      {provider ? (
        <Button variant="text" size="sm" label="Add key" onPress={() => onAddKey(provider)} />
      ) : null}
    </div>
  );
}

export function Ai({ data, view, actions }: SectionProps) {
  const { settings } = data;
  const devDetails = settings.ui.devDetails;
  const providers = data.providers;
  if (!providers) {
    return (
      <Group id="set-ai-loading" label="Features">
        <Text variant="small">Checking your providers.</Text>
      </Group>
    );
  }
  const consent = consentView(data.consent, settings);
  const notices = aiNotices(settings, providers);
  const features = featureRows(settings, providers, data.models ?? {});
  const hosted = hostedRows(providers, view.testing, devDetails);
  const local = localRows(providers, settings, view.testing, devDetails).map(r => ({
    ...r,
    address: view.addressDraft[r.provider] ?? r.address,
  }));
  const paid = paidSwitch(providers);
  const cap = settings.ai.dailyCap;
  const capId = capSelection(cap);
  const onAction = (provider: ProviderId, action: ProviderAction) => {
    if (action === 'test') void actions.testProvider(provider);
    else if (action === 'addKey') actions.openAddKey(provider, 'add');
    else if (action === 'replaceKey') actions.openAddKey(provider, 'replace');
    else if (action === 'remove') actions.askRemoveKey(provider);
  };
  const paused = capNote(data.usage, data.now);
  // Accounts from before the on-by-default owner decision keep AI off; this row is the one-time way to
  // bring them to the new default (owner's ask, 2026-11-06). Hidden when every account is already on.
  const offAccounts = data.accounts.filter(a => !a.demo && !a.aiAllowed);

  return (
    <>
      {notices.map(n => (
        <AiNoticeLine
          key={n.id}
          notice={n}
          onAddKey={provider => actions.openAddKey(provider as ProviderId, 'add')}
        />
      ))}

      <Group id="set-ai-features" label="Features">
        {features.map(row => (
          <Anchor key={row.feature} section="ai" anchor={row.feature}>
            <ProviderTable
              kind="features"
              rows={[row]}
              onChange={(feature, choice) => void actions.changeFeature(feature, choice)}
            />
          </Anchor>
        ))}
      </Group>

      <Group id="set-ai-providers" label="Providers">
        {hosted.map(row => (
          <Anchor key={row.provider} section="ai" anchor={`provider-${row.provider}`}>
            <ProviderTable kind="hosted" rows={[row]} onAction={onAction} />
          </Anchor>
        ))}
        {paid ? (
          <Row
            section="ai"
            anchor="geminiPaid"
            description="Aplos only sends mail to Gemini when its key is on a paid plan."
            control={id => (
              <Switch
                label="Gemini key is on a paid plan"
                labelledBy={id}
                checked={paid.paid}
                onChange={on => void actions.setGeminiPaid(on)}
              />
            )}
          />
        ) : null}
      </Group>

      <Group id="set-ai-local" label="On this Mac and custom">
        {local.map(row => (
          <Anchor key={row.provider} section="ai" anchor={`server-${row.provider}`}>
            <ProviderTable
              kind="local"
              rows={[row]}
              onAddressChange={(provider, address) => {
                if (isLocalId(provider)) actions.changeAddress(provider, address);
              }}
              onAction={onAction}
            />
            {view.addressError[row.provider] ? (
              <ErrorLine
                kind="reason"
                text={view.addressError[row.provider]!}
                retryable={false}
                placement="settings"
                onAction={() => {}}
              />
            ) : null}
          </Anchor>
        ))}
      </Group>

      <Group id="set-ai-privacy" label="Privacy and limits">
        <div
          className="settings-anchor"
          data-setting-anchor="howMailIsUsed"
          data-setting-section="ai"
        >
          <SettingRow
            id="set-ai-howMailIsUsed"
            label="How your mail is used"
            description="What is sent, what stays here, and your control."
            paletteId="setting.ai.howMailIsUsed"
            disclosure={{
              expanded: view.howOpen,
              onToggle: () => actions.toggleHow(),
              content: (
                <div className="settings-prose">
                  {HOW_MAIL_IS_USED.map(p => (
                    <div key={p.lead}>
                      <Text variant="label" tone="ink">
                        {p.lead}
                      </Text>
                      <Text variant="lede" tone="ink-2">
                        {p.body}
                      </Text>
                    </div>
                  ))}
                </div>
              ),
            }}
          />
        </div>
        {offAccounts.length > 0 ? (
          <Row
            section="ai"
            anchor="accountMail"
            description={
              offAccounts.length === 1
                ? `${accountLabel(offAccounts[0]!)} keeps its mail out of AI.`
                : `${offAccounts.length} accounts keep their mail out of AI.`
            }
            control={
              <Button
                variant="text"
                label="Turn on for existing accounts"
                onPress={() => {
                  moveFocusOffAccountMail();
                  void actions.allowMailForAccounts(offAccounts.map(a => a.id));
                }}
              />
            }
          />
        ) : null}
        <Row
          section="ai"
          anchor="background"
          description={backgroundLine(settings)}
          control={id => (
            <Switch
              label="Summarize in the background"
              labelledBy={id}
              checked={settings.ai.background}
              onChange={on => actions.setBackground(on)}
            />
          )}
          below={
            data.consent === undefined ? (
              <ErrorLine
                kind="reason"
                text="Couldn’t load this part."
                retryable={false}
                placement="settings"
                onAction={() => {}}
              />
            ) : settings.ai.background && consent.state === 'review' && !view.consentCard ? (
              <ErrorLine
                kind="consentNeeded"
                placement="settings"
                onAction={() => actions.openConsentCard()}
              />
            ) : undefined
          }
        />
        <Row
          section="ai"
          anchor="dailyCap"
          description={paused ?? capUsage(data.usage)}
          descriptionTone={paused ? 'attention' : 'default'}
          control={
            <Select
              label="Daily limit"
              options={withCurrent(CAP_OPTIONS, capId, formatTokens(cap.tokens))}
              value={capId}
              onChange={id => void actions.setCap(id)}
            />
          }
        />
      </Group>
    </>
  );
}
