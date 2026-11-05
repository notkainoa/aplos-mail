/**
 * Settings → AI (DESIGN 7.10, 9 rule 7; AGENTS.md). The Features table first (Ask, Summaries, Drafts, Plans, Voice,
 * each with a provider and a model; Voice lists only speech-to-text providers), then hosted providers (Groq is the
 * default), then "On this Mac and custom". Each provider shows its status and where its key comes from, never a
 * character of it; Test is on every row; a key from the environment shows Remove disabled with the reason.
 * Privacy sits behind one disclosure, and the background switch, consent re-review and daily cap follow.
 */
import { Switch } from '../../../ui/controls';
import { ErrorLine } from '../../../ui/list';
import { ProviderTable, SettingRow } from '../../../ui/settings';
import { Text } from '../../../ui/surfaces';
import type { ProviderAction, ProviderId } from '../../../ui/props';
import { Anchor, Group, Row, Select } from '../parts';
import {
  aiNotices,
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

export function Ai({ data, view, actions }: SectionProps) {
  const { settings } = data;
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
  const hosted = hostedRows(providers, view.testing);
  const local = localRows(providers, settings, view.testing).map(r => ({
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

  return (
    <>
      {notices.map(n => (
        <ErrorLine
          key={n.id}
          kind="reason"
          text={n.text}
          retryable={false}
          placement="settings"
          onAction={() => {}}
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
        <Row
          section="ai"
          anchor="background"
          description={backgroundLine(settings)}
          control={id => (
            <Switch
              label="Summarise in the background"
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
