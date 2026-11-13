// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/onboarding/onboarding.test.tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import type { ChoiceRowProps, OnboardingStepProps, StepButton } from '../props';
import { ChoiceGroup, ChoiceRow, ConsentCard, OnboardingStep } from './index';

const noop = () => {};
const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

function copyOf(markup: string): string[] {
  const decode = (s: string): string =>
    s
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  const attrs = [...markup.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g)].map(m =>
    decode(m[1]),
  );
  const text = markup
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(t => decode(t.trim()))
    .filter(Boolean);
  return [...attrs, ...text];
}

function assertCleanCopy(markup: string): void {
  for (const line of copyOf(markup)) assert.equal(copyProblem(line), null, `banned copy: ${line}`);
  assert.doesNotMatch(markup, /backdrop-filter|sparkle|wand|gradient/i);
}

const filled = (label: string, extra: Partial<StepButton> = {}): StepButton => ({
  label,
  emphasis: 'filled',
  keys: 'Return',
  keyHint: 'always',
  onSelect: noop,
  ...extra,
});
const quiet = (label: string, extra: Partial<StepButton> = {}): StepButton => ({
  label,
  emphasis: 'text',
  onSelect: noop,
  ...extra,
});

const step = (over: Partial<OnboardingStepProps> = {}): OnboardingStepProps => ({
  layout: 'step',
  title: 'Add your mail',
  titleId: 'step-title',
  footer: {
    dashes: { step: 2, of: 4 },
    note: 'setupContinues',
    buttons: [quiet('Back', { keys: 'Esc', keyHint: 'hint' })],
  },
  ...over,
});

/* ---------------------------------- OnboardingStep ---------------------------------- */

test('OnboardingStep welcome: a centred display line, one sentence, one filled button with Return, no icon', () => {
  const out = html(
    <OnboardingStep
      {...step({
        layout: 'welcome',
        title: 'Mail and calendar, one letter at a time.',
        titleId: 'h',
        lede: 'Aplos puts the email that needs you on top, sums each one up in a line, and keeps every action on a key.',
        actions: [filled('Add an account')],
        footer: {
          dashes: { step: 1, of: 4 },
          note: 'setupContinues',
          buttons: [quiet('Skip setup', { keys: 'Esc', keyHint: 'hint' })],
        },
        onTryDemo: noop,
      })}
    />,
  );
  assert.match(out, /data-layout="welcome"/);
  assert.match(out, /<main[^>]*aria-labelledby="h"/);
  assert.match(out, /<h1[^>]*id="h"[^>]*>Mail and calendar, one letter at a time\.<\/h1>/);
  assert.match(out, /keeps every action on a key\./);
  assert.equal((out.match(/data-variant="filled"/g) ?? []).length, 1);
  assert.match(
    out,
    /data-size="lg"[^>]*>.*?Add an account.*?<kbd class="ui-onb-kbd" data-key-hint="always">↩<\/kbd>/,
  );
  assert.match(out, /Setup continues in the background\./);
  assert.match(out, />Step 1 of 4</);
  assert.doesNotMatch(out, /<svg/);
  assertCleanCopy(out);
});

test('OnboardingStep: "Try demo mail" with its tooltip, the footer step words and note, the hidden status line', () => {
  const out = html(
    <OnboardingStep
      {...step({
        onTryDemo: noop,
        phaseStatus: 'Connected. Looking for your mail.',
        footer: {
          dashes: { step: 3, of: 4 },
          note: 'setupContinues',
          buttons: [quiet('Back', { keys: 'Esc', keyHint: 'hint' })],
        },
      })}
    />,
  );
  assert.match(out, />Try demo mail</);
  assert.match(out, /title="Load sample mail to look around\. Remove it any time in Settings\."/);
  assert.match(out, /aria-describedby="[^"]+"/);
  assert.match(
    out,
    /<p class="ui-onboarding-step__sr" role="status">Connected\. Looking for your mail\.<\/p>/,
  );
  assert.match(out, /<span class="ui-onboarding-step__where">Step 3 of 4<\/span>/);
  assert.doesNotMatch(out, /ui-onboarding-step__dashes/, 'the words say it; no dashes beside them');
  // The footer Esc is a hint: present in the markup, hidden until "Show all key hints".
  assert.match(out, /<kbd class="ui-onb-kbd" data-key-hint="hint">Esc<\/kbd>/);
  const none = html(<OnboardingStep {...step({ phaseStatus: undefined })} />);
  assert.doesNotMatch(none, />Try demo mail</);
  assert.match(none, /role="status"/);
});

test('OnboardingStep: step layout has a heading title, children, "More options" and a body action row', () => {
  const out = html(
    <OnboardingStep
      {...step({
        title: 'Set up AI',
        lede: 'AI sums up each email in a line, drafts replies and answers questions about your mail. It is optional.',
        children: <p>Body</p>,
        moreOptions: { expanded: false, onToggle: noop, content: <p>Own key</p> },
        actions: [filled('Continue'), quiet('Skip for now')],
      })}
    />,
  );
  assert.match(out, /data-layout="step"/);
  assert.match(out, /<p>Body<\/p>/);
  assert.match(out, /aria-expanded="false"[^>]*aria-controls="[^"]+"[^>]*>.*?More options/);
  assert.match(out, /hidden=""[^>]*><p>Own key<\/p>/);
  assert.match(out, />Continue<\/span><kbd class="ui-onb-kbd" data-key-hint="always">↩<\/kbd>/);
  assert.match(out, />Skip for now</);
  assert.match(out, /autofocus=""/);
  // A text verb carries its key in the tooltip only.
  const withKey = html(
    <OnboardingStep {...step({ actions: [quiet('Skip for now', { keys: 'Esc' })] })} />,
  );
  assert.match(withKey, /title="Skip for now · Esc"/);
  assert.doesNotMatch(withKey, /ui-onb-kbd" data-key-hint="tooltip"/);
  const open = html(
    <OnboardingStep
      {...step({ moreOptions: { expanded: true, onToggle: noop, content: <p>Own key</p> } })}
    />,
  );
  assert.match(open, /aria-expanded="true"/);
  assert.doesNotMatch(open, /ui-onboarding-step__more-content" id="[^"]+" hidden/);
});

test('OnboardingStep: a first-sync footer has no dashes and shows Esc opens Aplos; busy and disabled buttons say so', () => {
  const out = html(
    <OnboardingStep
      {...step({
        title: 'Getting your mail',
        footer: {
          note: 'escOpensAplos',
          buttons: [
            quiet('Skip setup'),
            filled('Open Aplos', { disabled: true }),
            filled('Continue anyway', { busy: true, keys: undefined, keyHint: undefined }),
          ],
        },
      })}
    />,
  );
  assert.doesNotMatch(out, /ui-onboarding-step__dashes/);
  assert.match(out, /<kbd class="ui-onb-kbd">Esc<\/kbd> opens Aplos/);
  assert.match(out, /disabled=""[^>]*>.*?Open Aplos/);
  assert.match(
    out,
    /aria-busy="true"[^>]*>.*?Continue anyway<\/span><span class="ui-onb-spinner" aria-hidden="true">/,
  );
  assert.match(out, /data-size="md"/);
  assertCleanCopy(out);
});

test('OnboardingStep: a command key comes from the registry', () => {
  const out = html(
    <OnboardingStep
      {...step({
        actions: [
          {
            label: 'Open Aplos',
            emphasis: 'filled',
            commandId: 'nav.calendar',
            keyHint: 'always',
            onSelect: noop,
          },
        ],
      })}
    />,
  );
  assert.match(out, /<kbd class="ui-onb-kbd" data-key-hint="always">⌃6<\/kbd>/);
});

test('OnboardingStep worst case: 300-character title, unbreakable address as lede, CJK, Arabic, emoji', () => {
  for (const title of [
    'T'.repeat(300),
    'a'.repeat(40) + '@' + 'b'.repeat(39),
    'A',
    'メールを追加',
    'أضف بريدك',
    'Hello 🎉',
  ]) {
    const out = html(
      <OnboardingStep {...step({ title, lede: title, actions: [filled(title.slice(0, 30))] })} />,
    );
    assert.ok(out.includes(`dir="auto">${title}</h1>`), title.slice(0, 12));
    assert.ok(out.includes(`>${title}</p>`));
  }
});

/* ---------------------------------- ChoiceRow ---------------------------------- */

const row = (over: Partial<ChoiceRowProps> = {}): ChoiceRowProps => ({
  id: 'row',
  role: 'static',
  label: 'Google',
  ...over,
});

test('ChoiceRow link: one button with a chevron, a leading icon, labelled by its name', () => {
  const out = html(<ChoiceRow {...row({ role: 'link', icon: 'mail', onPress: noop })} />);
  assert.match(out, /^<button[^>]*data-role="link"/);
  assert.match(out, /aria-labelledby="row-label"/);
  assert.match(out, /id="row-label"[^>]*>Google</);
  assert.match(out, /lucide-chevron-right/);
  assert.match(out, /lucide-mail/);
  assertCleanCopy(out);
});

test('ChoiceRow static: found provider with a detail and a status word that comes with an icon', () => {
  const out = html(
    <ChoiceRow
      {...row({
        icon: 'mail',
        detail: "You sign in on Google's own page in your browser. Aplos never sees your password.",
        status: { text: 'Found', tone: 'ok' },
      })}
    />,
  );
  assert.match(out, /data-role="static"[^>]*data-has-detail="true"/);
  assert.match(out, /Aplos never sees your password\./);
  assert.match(out, /data-tone="ok"[^>]*><svg[^>]*lucide-check[^>]*>.*?<\/svg>Found</);
  const bad = html(
    <ChoiceRow {...row({ status: { text: 'Needs a sign in', tone: 'attention' } })} />,
  );
  assert.match(bad, /data-tone="attention"[^>]*><svg[^>]*lucide-circle-alert/);
  const dim = html(<ChoiceRow {...row({ status: { text: 'Not running', tone: 'dim' } })} />);
  assert.doesNotMatch(dim, /<svg/);
});

test('ChoiceRow radio: aria-checked, Groq Default with its key source in mono, Works status and a Test control', () => {
  const out = html(
    <ChoiceRow
      {...row({
        id: 'groq',
        role: 'radio',
        label: 'Groq',
        tag: 'Default',
        keySource: { kind: 'environment', variable: 'GROQ_API_KEY' },
        selected: true,
        status: { text: 'Works · 0.4 s', tone: 'ok' },
        control: <button type="button">Test</button>,
        onPress: noop,
      })}
    />,
  );
  assert.match(out, /role="radio"[^>]*aria-checked="true"/);
  assert.match(
    out,
    /aria-labelledby="groq-label groq-tag groq-detail"/,
    'the name holds the visible words',
  );
  assert.match(out, />Default</);
  assert.match(out, /Key found in the environment as <code>GROQ_API_KEY<\/code>/);
  assert.match(out, /Works · 0\.4 s/);
  assert.match(out, /<button type="button">Test<\/button>/);
  // The control sits outside the radio, never nested in it.
  assert.ok(out.indexOf('<button type="button">Test') > out.indexOf('ui-choice-row__end'));
  const unchecked = html(<ChoiceRow {...row({ role: 'radio', selected: false })} />);
  assert.match(unchecked, /aria-checked="false"/);
});

test('ChoiceRow radio: the chosen row is the one tab stop; an unchosen row is out of the tab order', () => {
  assert.match(
    html(<ChoiceRow {...row({ role: 'radio', selected: true })} />),
    /role="radio"[^>]*tabindex="0"/,
  );
  assert.match(
    html(<ChoiceRow {...row({ role: 'radio', selected: false })} />),
    /role="radio"[^>]*tabindex="-1"/,
  );
});

test('ChoiceRow link with a control: the control sits beside the button, never inside it', () => {
  const out = html(
    <ChoiceRow
      {...row({
        role: 'link',
        label: 'Microphone',
        onPress: noop,
        control: <button type="button">Allow…</button>,
      })}
    />,
  );
  assert.match(out, /data-split="true"/);
  assert.equal((out.match(/<button/g) ?? []).length, 2);
  const link = /<button[^>]*class="ui-choice-row__link"[^>]*>(.*?)<\/button>/.exec(out);
  assert.ok(link);
  assert.doesNotMatch(link[1], /<button/);
  assert.match(out, /<button type="button">Allow…<\/button>/);
  // Without a control it stays one button.
  assert.equal(
    (html(<ChoiceRow {...row({ role: 'link', onPress: noop })} />).match(/<button/g) ?? []).length,
    1,
  );
});

test('ChoiceRow key sources: saved, missing and local say so, never any key characters', () => {
  assert.match(
    html(<ChoiceRow {...row({ keySource: { kind: 'keychain' } })} />),
    /Saved in Keychain/,
  );
  assert.match(
    html(<ChoiceRow {...row({ keySource: { kind: 'none', variable: 'ANTHROPIC_API_KEY' } })} />),
    /No key yet · reads <code>ANTHROPIC_API_KEY<\/code>/,
  );
  assert.match(
    html(<ChoiceRow {...row({ keySource: { kind: 'local' } })} />),
    /On this Mac · no key needed/,
  );
});

test('ChoiceRow: a detail dot shows found or not running; an account mark is a tag colour custom property; a permission has a control', () => {
  const ok = html(
    <ChoiceRow
      {...row({ label: 'Ollama', detailDot: 'ok', detail: 'Found at localhost:11434' })}
    />,
  );
  assert.match(ok, /ui-choice-row__dot" data-state="ok"/);
  const off = html(
    <ChoiceRow {...row({ label: 'LM Studio', detailDot: 'off', detail: 'Not running' })} />,
  );
  assert.match(off, /data-state="off"/);
  const account = html(
    <ChoiceRow
      {...row({
        label: 'alex.moreno@gmail.com',
        mark: 'sky',
        detail: 'Google',
        status: { text: 'Connected', tone: 'ok' },
      })}
    />,
  );
  assert.match(account, /--swatch:var\(--tag-sky\)/);
  const perm = html(
    <ChoiceRow
      {...row({
        label: 'Microphone',
        icon: 'mic',
        detail: 'Hold A to dictate to Ask, or R to dictate a reply.',
        control: <button type="button">Allow…</button>,
      })}
    />,
  );
  assert.match(perm, /Allow…/);
  assert.match(perm, /lucide-mic/);
});

test('ChoiceRow worst case: 300-character label, unbreakable address, one-letter name, CJK, Arabic, emoji', () => {
  for (const label of [
    'L'.repeat(300),
    'a'.repeat(40) + '@' + 'b'.repeat(39),
    'A',
    'グーグル',
    'جوجل',
    'Mail 🎉',
  ]) {
    for (const role of ['link', 'radio', 'static'] as const) {
      const out = html(
        <ChoiceRow {...row({ role, label, detail: label, tag: label.slice(0, 8) })} />,
      );
      assert.ok(out.includes(`dir="auto">${label}</span>`), `${role} ${label.slice(0, 8)}`);
    }
  }
});

/* ---------------------------------- ConsentCard ---------------------------------- */

const consent = {
  provider: 'Groq',
  model: 'llama-3.3-70b-versatile',
  sent: 'The sender, subject and text of each new email, and your question when you use Ask. Attachments are not sent.',
  onAllow: noop,
  onNotNow: noop,
};

test('ConsentCard: provider, model and what is sent in one card, Allow with Return, Not now', () => {
  const out = html(<ConsentCard {...consent} />);
  assert.equal((out.match(/ui-consent-card__card/g) ?? []).length, 1);
  assert.match(out, /<dt>Provider<\/dt><dd>Groq<\/dd>/);
  assert.match(out, /<dt>Model<\/dt><dd>llama-3\.3-70b-versatile<\/dd>/);
  assert.match(out, /<dt>What is sent<\/dt><dd>The sender, subject and text of each new email/);
  assert.match(out, /Attachments are not sent\./);
  assert.match(
    out,
    /data-variant="filled"[^>]*autofocus=""[^>]*title="Allow · ↩"[^>]*>.*?Allow<\/span><kbd class="ui-onb-kbd" data-key-hint="always">↩<\/kbd>/,
  );
  assert.match(out, />Not now</);
  assert.doesNotMatch(out, /Ollama and LM Studio keep/);
  assertCleanCopy(out);
});

test('ConsentCard: a hosted provider adds the lock line about Ollama and LM Studio', () => {
  const out = html(<ConsentCard {...consent} showLocalNote />);
  assert.match(out, /lucide-lock/);
  assert.match(out, /Ollama and LM Studio keep all of this on your Mac\./);
});

test('ConsentCard worst case: a 300-character model and sentence, CJK and RTL provider, emoji', () => {
  const out = html(
    <ConsentCard
      {...consent}
      provider="プロバイダー"
      model={'m'.repeat(300)}
      sent={'غير ' + 's'.repeat(300) + ' 🎉'}
    />,
  );
  assert.ok(out.includes('m'.repeat(300)));
  assert.ok(out.includes('プロバイダー') && out.includes('🎉'));
});

test('the barrel exports the four components of the family', async () => {
  const barrel = await import('./index');
  assert.deepEqual(Object.keys(barrel).sort(), [
    'ChoiceGroup',
    'ChoiceRow',
    'ConsentCard',
    'OnboardingStep',
  ]);
});

test('ChoiceGroup: a named radiogroup around radio rows with one tab stop', () => {
  const out = html(
    <ChoiceGroup label="AI provider" value="groq" onChange={noop}>
      <ChoiceRow id="groq" role="radio" label="Groq" selected onPress={noop} />
      <ChoiceRow id="openai" role="radio" label="OpenAI" onPress={noop} />
    </ChoiceGroup>,
  );
  assert.match(out, /^<div class="ui-choice-group" role="radiogroup" aria-label="AI provider">/);
  assert.equal((out.match(/ role="radio"/g) ?? []).length, 2);
  assert.equal((out.match(/tabindex="0"/g) ?? []).length, 1);
  assert.match(out, /aria-checked="true"[^>]*tabindex="0"/);
  const named = html(
    <ChoiceGroup label="AI provider" labelledBy="ai-title" value={null} onChange={noop}>
      <ChoiceRow id="groq" role="radio" label="Groq" />
    </ChoiceGroup>,
  );
  assert.match(named, /aria-labelledby="ai-title"/);
  assert.doesNotMatch(named, /aria-label="AI provider"/);
});
