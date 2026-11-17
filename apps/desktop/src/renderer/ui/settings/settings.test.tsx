// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/settings/settings.test.tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import type { KeyRecorderProps, ProviderTableProps } from '../props';
import { focusSettingRow, KeyRecorder, ProviderTable, SettingRow } from './index';
import { chordText, recorderKeyAction } from './KeyRecorder';
import { latencyText } from './ProviderTable';

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

/* ---------------------------------- SettingRow ---------------------------------- */

test('SettingRow: label id for the control, description, tag, meta and the control column', () => {
  const out = html(
    <SettingRow
      id="theme"
      label="Theme"
      description="Light, dark, or match the system."
      tag="Default"
      meta="Google"
      control={
        <button type="button" role="switch" aria-checked="true" aria-labelledby="theme">
          Theme
        </button>
      }
    />,
  );
  assert.match(out, /class="ui-setting-row"[^>]*data-has-description="true"/);
  assert.match(out, /<span class="ui-setting-row__label" id="theme" dir="auto">Theme<\/span>/);
  assert.match(out, /id="theme-description"/);
  assert.match(out, /Light, dark, or match the system\./);
  assert.match(out, />Default</);
  assert.match(out, />Google</);
  assert.match(out, /class="ui-setting-row__control"/);
  assertCleanCopy(out);
});

test('SettingRow: no description is a 40 px row; attention shows an alert icon with the words', () => {
  const plain = html(<SettingRow id="a" label="Single-key shortcuts" />);
  assert.match(plain, /data-has-description="false"/);
  assert.doesNotMatch(plain, /ui-setting-row__control/);
  const attention = html(
    <SettingRow
      id="acct"
      label="alex.moreno@gmail.com"
      mark="sky"
      description="Google needs you to sign in again."
      descriptionTone="attention"
    />,
  );
  assert.match(attention, /data-tone="attention"/);
  assert.match(attention, /<svg[^>]*class="[^"]*ui-set-icon/);
  assert.match(attention, /--swatch:var\(--tag-sky\)/);
  assert.match(attention, /Google needs you to sign in again\./);
});

test('SettingRow disclosure: one button with aria-expanded and the folded text hidden until opened', () => {
  const closed = html(
    <SettingRow
      id="how"
      label="How your mail is used"
      description="What is sent, what stays here, and your control."
      disclosure={{ expanded: false, onToggle: noop, content: <p>What is sent.</p> }}
    />,
  );
  assert.match(closed, /<button[^>]*aria-expanded="false"[^>]*aria-controls="how-content"/);
  assert.match(closed, /id="how-content" hidden=""/);
  const open = html(
    <SettingRow
      id="how"
      label="How your mail is used"
      disclosure={{ expanded: true, onToggle: noop, content: <p>What is sent.</p> }}
      below={<span>Extra line</span>}
    />,
  );
  assert.match(open, /aria-expanded="true"/);
  assert.doesNotMatch(open, /hidden=""/);
  assert.match(open, /Extra line/);
});

test('SettingRow worst case: 300-character label, unbreakable address, one-letter label, CJK, Arabic, emoji', () => {
  for (const label of [
    'L'.repeat(300),
    'a'.repeat(40) + '@' + 'b'.repeat(39),
    'A',
    '通知の設定',
    'إعدادات الإشعارات',
    'Party 🎉',
  ]) {
    const out = html(
      <SettingRow id="w" label={label} description={label} meta={label} tag="Default" />,
    );
    assert.ok(out.includes(`dir="auto">${label}</span>`), label.slice(0, 12));
  }
});

/* ---------------------------------- ProviderTable ---------------------------------- */

const features: ProviderTableProps = {
  kind: 'features',
  rows: [
    {
      feature: 'ask',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      providerOptions: ['groq', 'openai', 'ollama'],
      modelOptions: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    },
    {
      feature: 'summaries',
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      providerOptions: ['groq'],
      modelOptions: ['llama-3.1-8b-instant'],
    },
    {
      feature: 'drafts',
      provider: 'openai',
      model: 'gpt-5-mini',
      providerOptions: ['groq', 'openai'],
      modelOptions: ['gpt-5-mini'],
    },
    {
      feature: 'plans',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      providerOptions: ['groq'],
      modelOptions: ['openai/gpt-oss-120b'],
    },
    {
      feature: 'voice',
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      providerOptions: ['groq', 'openai'],
      modelOptions: ['whisper-large-v3-turbo'],
    },
  ],
  onChange: noop,
};

test('ProviderTable features: five rows with a labelled provider and model picker and what each feature does', () => {
  const out = html(<ProviderTable {...features} />);
  for (const name of ['Ask', 'Summaries', 'Drafts', 'Plans', 'Voice']) {
    assert.match(out, new RegExp(`aria-label="${name} provider"`));
    assert.match(out, new RegExp(`aria-label="${name} model"`));
    assert.match(out, new RegExp(`dir="auto">${name}</span>`));
  }
  assert.match(out, /Turns speech into text for dictation\./);
  assert.match(out, /<option value="groq" selected="">Groq<\/option>/);
  assert.match(out, /<option value="openai\/gpt-oss-120b" selected="">/);
  assertCleanCopy(out);
});

test('ProviderTable features: a model that is not in the list is still shown and chosen', () => {
  const out = html(
    <ProviderTable
      kind="features"
      onChange={noop}
      rows={[
        {
          feature: 'ask',
          provider: 'groq',
          model: 'custom/legacy-model',
          providerOptions: ['groq'],
          modelOptions: ['a'],
        },
      ]}
    />,
  );
  assert.match(out, /<option value="custom\/legacy-model" selected="">/);
});

const hosted = (
  over: Partial<Extract<ProviderTableProps, { kind: 'hosted' }>> = {},
): ProviderTableProps => ({
  kind: 'hosted',
  onAction: noop,
  rows: [
    {
      provider: 'groq',
      isDefault: true,
      keySource: { kind: 'environment', variable: 'GROQ_API_KEY' },
      status: { kind: 'works', latencyMs: 400 },
    },
    {
      provider: 'openai',
      isDefault: false,
      keySource: { kind: 'keychain' },
      status: { kind: 'testing' },
    },
    {
      provider: 'anthropic',
      isDefault: false,
      keySource: { kind: 'none', variable: 'ANTHROPIC_API_KEY' },
      status: { kind: 'needsKey' },
    },
    {
      provider: 'openrouter',
      isDefault: false,
      keySource: { kind: 'keychain' },
      status: { kind: 'refused' },
    },
    {
      provider: 'gemini',
      isDefault: false,
      keySource: { kind: 'keychain' },
      status: { kind: 'ready' },
    },
    {
      provider: 'opencode-go',
      isDefault: false,
      keySource: { kind: 'environment', variable: 'OPENCODE_API_KEY' },
      status: { kind: 'unreachable' },
    },
  ],
  ...over,
});

test('ProviderTable hosted: key source and status in words, Default tag, never any key characters', () => {
  const out = html(<ProviderTable {...hosted()} />);
  assert.match(out, />Groq</);
  assert.match(out, />Default</);
  assert.match(out, /Key set on this Mac · GROQ_API_KEY/);
  assert.match(out, /Saved in Keychain/);
  assert.match(out, /No key yet · reads ANTHROPIC_API_KEY/);
  assert.match(out, /Works · 0\.4 s/);
  assert.match(out, /Testing…/);
  assert.doesNotMatch(out, /Needs a key/, 'one status per row: No key yet says it');
  assert.match(out, /Key refused/);
  assert.match(out, />Ready</);
  assert.match(out, /Not reachable/);
  assert.match(out, /aria-busy="true"/);
  assert.doesNotMatch(out, /<input|sk-|gsk_/);
  assertCleanCopy(out);
});

test('ProviderTable hosted: Remove is disabled for an environment key, with the reason as tooltip and description', () => {
  const out = html(<ProviderTable {...hosted()} />);
  const groqRow = out.slice(
    out.indexOf('data-provider="groq"'),
    out.indexOf('data-provider="openai"'),
  );
  assert.match(
    groqRow,
    /aria-disabled="true"[^>]*title="This key comes from GROQ_API_KEY in your environment\. Remove it there\."/,
  );
  assert.match(groqRow, /aria-describedby="[^"]+"/);
  assert.match(
    groqRow,
    /<span class="ui-provider-table__sr"[^>]*>This key comes from GROQ_API_KEY in your environment\. Remove it there\.<\/span>/,
  );
  const openaiRow = out.slice(
    out.indexOf('data-provider="openai"'),
    out.indexOf('data-provider="anthropic"'),
  );
  assert.match(openaiRow, />Remove</);
  assert.doesNotMatch(openaiRow, /Remove it there/);
  // Test is disabled while it runs.
  assert.match(
    openaiRow,
    /aria-disabled="true"[^>]*aria-label="Test OpenAI"|aria-label="Test OpenAI"[^>]*aria-disabled="true"/,
  );
});

test('ProviderTable hosted: no key offers "Add key"; a refused key adds a plain line with Replace key', () => {
  const out = html(<ProviderTable {...hosted()} />);
  const claude = out.slice(
    out.indexOf('data-provider="anthropic"'),
    out.indexOf('data-provider="openrouter"'),
  );
  assert.match(claude, />Add key</);
  assert.doesNotMatch(claude, />Test</);
  assert.match(
    out,
    /OpenRouter refused the saved key, so nothing was sent\. Replace it with a fresh one\. Your other providers are not affected\./,
  );
  assert.match(out, />Replace key</);
  assert.match(out, /Couldn&#x27;t reach OpenCode Go\. Nothing was sent\./);
  const env = html(
    <ProviderTable
      {...hosted({
        rows: [
          {
            provider: 'groq',
            isDefault: true,
            keySource: { kind: 'environment', variable: 'GROQ_API_KEY' },
            status: { kind: 'refused' },
          },
        ],
      })}
    />,
  );
  assert.match(
    env,
    /Groq refused the key set on this Mac, so nothing was sent\. Fix it where it was set \(GROQ_API_KEY\)\./,
  );
  assert.doesNotMatch(env, />Replace key</);
});

test('latencyText: seconds with one decimal', () => {
  assert.equal(latencyText(400), '0.4 s');
  assert.equal(latencyText(1250), '1.3 s');
  assert.equal(latencyText(0), '0.0 s');
});

test('ProviderTable local: address field with the default as placeholder, running state, key optional', () => {
  const out = html(
    <ProviderTable
      kind="local"
      onAddressChange={noop}
      onAction={noop}
      rows={[
        {
          provider: 'ollama',
          address: 'http://localhost:11434',
          defaultAddress: 'http://localhost:11434',
          running: true,
          keySource: { kind: 'local' },
          status: { kind: 'works', latencyMs: 90 },
        },
        {
          provider: 'lmstudio',
          address: '',
          defaultAddress: 'http://localhost:1234',
          running: false,
        },
        {
          provider: 'custom',
          address: 'https://llm.example.org/v1',
          defaultAddress: '',
          keySource: { kind: 'none', variable: 'CUSTOM_AI_API_KEY' },
        },
      ]}
    />,
  );
  assert.match(out, /aria-label="Ollama address"/);
  assert.match(out, /aria-label="LM Studio address"/);
  assert.match(out, /aria-label="Custom server address"/);
  assert.match(out, /value="http:\/\/localhost:11434"/);
  assert.match(out, /placeholder="http:\/\/localhost:1234"/);
  assert.match(out, /placeholder="https:\/\/your-server\.example\/v1"/);
  assert.match(out, /On this Mac · running · no key needed/);
  assert.match(out, /On this Mac · no key needed/);
  assert.match(out, /Any OpenAI-compatible server · key optional/);
  assert.match(out, />Add key</);
  assert.match(out, /Works · 0\.1 s/);
  assert.match(out, /spellcheck="false"/i);
  assertCleanCopy(out);
});

test('ProviderTable local: a saved or environment key offers Replace key and Remove, an environment key cannot be removed', () => {
  const out = html(
    <ProviderTable
      kind="local"
      onAddressChange={noop}
      onAction={noop}
      rows={[
        {
          provider: 'ollama',
          address: 'http://localhost:11434',
          defaultAddress: 'http://localhost:11434',
          running: true,
          keySource: { kind: 'keychain' },
        },
        {
          provider: 'custom',
          address: 'https://x.example/v1',
          defaultAddress: '',
          keySource: { kind: 'environment', variable: 'CUSTOM_AI_API_KEY' },
        },
      ]}
    />,
  );
  assert.match(out, />Replace key</);
  assert.match(out, /Saved in Keychain/);
  assert.match(
    out,
    /title="This key comes from CUSTOM_AI_API_KEY in your environment\. Remove it there\."/,
  );
});

test('ProviderTable local: a refused or unreachable server explains itself like a hosted row', () => {
  const out = html(
    <ProviderTable
      kind="local"
      onAddressChange={noop}
      onAction={noop}
      rows={[
        {
          provider: 'custom',
          address: 'https://x.example/v1',
          defaultAddress: '',
          keySource: { kind: 'keychain' },
          status: { kind: 'refused' },
        },
        {
          provider: 'ollama',
          address: 'http://localhost:11434',
          defaultAddress: 'http://localhost:11434',
          running: false,
          status: { kind: 'unreachable' },
        },
      ]}
    />,
  );
  assert.match(out, /Custom server refused the saved key, so nothing was sent\./);
  assert.match(out, /Couldn&#x27;t reach Ollama\. Nothing was sent\./);
  assertCleanCopy(out);
});

test('ProviderTable local: a server that is not running is a quiet status, not an error line', () => {
  const out = html(
    <ProviderTable
      kind="local"
      onAddressChange={noop}
      onAction={noop}
      rows={[
        {
          provider: 'ollama',
          address: '',
          defaultAddress: 'http://localhost:11434',
          running: false,
          status: { kind: 'notRunning' },
        },
      ]}
    />,
  );
  assert.match(out, /data-tone="quiet"/);
  assert.match(out, />Not running</);
  assert.doesNotMatch(out, /Couldn&#x27;t reach|ui-provider-table__fix/);
});

test('SettingRow: the tag is never shrunk by a long meta', () => {
  const out = html(<SettingRow id="r" label="Groq" meta={'m'.repeat(200)} tag="Default" />);
  assert.match(out, /class="ui-setting-row__tag">Default</);
});

test('ProviderTable worst case: unbreakable address, 300-character model, CJK and RTL addresses', () => {
  const longModel = 'm'.repeat(300);
  const feat = html(
    <ProviderTable
      kind="features"
      onChange={noop}
      rows={[
        {
          feature: 'ask',
          provider: 'groq',
          model: longModel,
          providerOptions: ['groq'],
          modelOptions: [longModel],
        },
      ]}
    />,
  );
  assert.ok(feat.includes(longModel));
  const addr = 'https://' + 'h'.repeat(80) + '.example/v1';
  const local = html(
    <ProviderTable
      kind="local"
      onAddressChange={noop}
      rows={[
        { provider: 'custom', address: addr, defaultAddress: '' },
        {
          provider: 'ollama',
          address: 'http://サーバー.example',
          defaultAddress: 'http://localhost:11434',
        },
        {
          provider: 'lmstudio',
          address: 'http://خادم.example',
          defaultAddress: 'http://localhost:1234',
        },
      ]}
    />,
  );
  assert.ok(local.includes(`value="${addr}"`));
  assert.ok(local.includes('サーバー') && local.includes('خادم'));
});

/* ---------------------------------- KeyRecorder ---------------------------------- */

const recorder = (over: Partial<KeyRecorderProps> = {}): KeyRecorderProps => ({
  commandId: 'mail.done',
  label: 'Done',
  chords: ['e'],
  changed: false,
  state: 'idle',
  onStart: noop,
  onChord: noop,
  onReplace: noop,
  onCancel: noop,
  onReset: noop,
  ...over,
});

test('chordText: canonical chords become keycaps, display text passes through', () => {
  assert.equal(chordText('e'), 'E');
  assert.equal(chordText('shift+r'), '⇧R');
  assert.equal(chordText('meta+k'), '⌘K');
  assert.equal(chordText('alt+ArrowDown'), '⌥↓');
  assert.equal(chordText('ctrl+6'), '⌃6');
  assert.equal(chordText('⌘J'), '⌘J');
});

test('KeyRecorder idle: label, a button that names the shortcut, keycaps, no Reset when unchanged', () => {
  const out = html(<KeyRecorder {...recorder({ chords: ['j', 'ArrowDown'] })} />);
  assert.match(out, /data-state="idle"/);
  assert.match(out, />Done</);
  assert.match(out, /aria-label="Change the shortcut for Done\. Now ↓ or J"/);
  assert.match(out, /title="Click to change"/);
  assert.match(
    out,
    /<kbd class="ui-key-recorder__kbd">↓<\/kbd><span class="ui-key-recorder__or">or<\/span><kbd class="ui-key-recorder__kbd">J<\/kbd>/,
  );
  assert.doesNotMatch(out, />Reset</);
  assert.doesNotMatch(out, /conflict/);
  assertCleanCopy(out);
});

test('KeyRecorder idle: a changed shortcut offers Reset; a clash at rest is marked with words and an icon', () => {
  const out = html(
    <KeyRecorder
      {...recorder({
        chords: ['meta+j'],
        changed: true,
        conflictWith: { commandId: 'ask.dock', label: 'Toggle the Ask dock' },
      })}
    />,
  );
  assert.match(out, /aria-label="Reset Done to its default"[^>]*>Reset</);
  assert.match(out, /Same keys as Toggle the Ask dock/);
  assert.match(out, /<svg[^>]*class="[^"]*ui-set-icon/);
  assert.match(out, /<kbd class="ui-key-recorder__kbd"><span class="ui-key-mod">⌘<\/span>J<\/kbd>/);
  const none = html(<KeyRecorder {...recorder({ chords: [] })} />);
  assert.match(none, /Now not set/);
  assert.match(none, />None</);
});

test('KeyRecorder recording: the hint, a waiting keycap, a capture button and Cancel', () => {
  const out = html(<KeyRecorder {...recorder({ state: 'recording' })} />);
  assert.match(out, /data-state="recording"/);
  assert.match(out, /Press the new keys · Esc to cancel/);
  assert.match(
    out,
    /aria-label="Recording a new shortcut for Done\. Press the new keys, or Escape to cancel\."/,
  );
  assert.match(out, /data-role="wait"/);
  assert.match(out, />Cancel</);
  assert.doesNotMatch(out, />Replace</);
  assert.doesNotMatch(out, /Click to change/);
});

test('KeyRecorder conflict: the pressed chord, who owns it, Replace and Cancel', () => {
  const out = html(
    <KeyRecorder
      {...recorder({
        state: 'conflict',
        pendingChord: 'l',
        conflictWith: { commandId: 'mail.later', label: 'Later' },
      })}
    />,
  );
  assert.match(out, /data-state="conflict"/);
  assert.match(out, /data-role="new">L<\/kbd>/);
  assert.match(out, /Already used by Later/);
  assert.match(out, /role="status"/);
  assert.match(out, /aria-label="Replace the shortcut of Later"[^>]*>Replace</);
  assert.match(out, />Cancel</);
  assertCleanCopy(out);
});

test('KeyRecorder conflict: Return replaces and Tab is not recorded, so Replace and Cancel are reachable by key', () => {
  const key = (
    k: string,
    extra: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {},
  ) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...extra });
  assert.equal(recorderKeyAction('conflict', key('Enter')), 'replace');
  assert.equal(recorderKeyAction('conflict', key('Tab')), 'move');
  assert.equal(recorderKeyAction('conflict', key('x')), 'record');
  assert.equal(recorderKeyAction('conflict', key('Enter', { metaKey: true })), 'record'); // ⌘Return is a chord
  // Before a chord is pressed every key is the new chord, Tab and Return included.
  assert.equal(recorderKeyAction('recording', key('Tab')), 'record');
  assert.equal(recorderKeyAction('recording', key('Enter')), 'record');
});

test('KeyRecorder: a long conflicting label is truncated in one line, with the full text as a tooltip', () => {
  const long = 'Later '.repeat(60).trim();
  const out = html(
    <KeyRecorder
      {...recorder({
        state: 'conflict',
        pendingChord: 'l',
        conflictWith: { commandId: 'mail.later', label: long },
      })}
    />,
  );
  assert.match(out, /class="ui-key-recorder__conflict-text"/);
  assert.ok(out.includes(`title="Already used by ${long}"`));
  const idle = html(
    <KeyRecorder
      {...recorder({ label: long, conflictWith: { commandId: 'mail.later', label: long } })}
    />,
  );
  assert.match(idle, /class="ui-key-recorder__conflict-text"/);
  assert.ok(idle.includes(`title="${long}"`));
});

test('KeyRecorder worst case: 300-character label, many chords, one-letter command, emoji and CJK labels', () => {
  const many = Array.from({ length: 6 }, (_, i) => `ctrl+${i}`);
  const out = html(<KeyRecorder {...recorder({ label: 'L'.repeat(300), chords: many })} />);
  assert.equal((out.match(/class="ui-key-recorder__kbd"/g) ?? []).length, 6);
  for (const label of ['A', '完了', 'تم', 'Done 🎉']) {
    assert.ok(
      html(<KeyRecorder {...recorder({ label })} />).includes(
        `dir="auto" title="${label}">${label}</span>`,
      ),
    );
  }
});

test('SettingRow paletteId: the row carries its anchor so settings/<section>#<row> can scroll to it', () => {
  const out = html(
    <SettingRow id="undo-label" label="Undo send" paletteId="setting.mail.undoSeconds" />,
  );
  assert.match(
    out,
    /<div id="undoSeconds" class="ui-setting-row"[^>]*data-setting-anchor="undoSeconds"/,
  );
  // The label keeps its own id, so the two never clash.
  assert.match(out, /id="undo-label"/);
  // When the anchor is the label's id the label is the target and the row does not repeat it.
  const same = html(
    <SettingRow id="undoSeconds" label="Undo send" paletteId="setting.mail.undoSeconds" />,
  );
  assert.equal((same.match(/id="undoSeconds"/g) ?? []).length, 1);
  assert.match(same, /data-setting-anchor="undoSeconds"/);
  // A disclosure row carries it too; no paletteId, no anchor.
  const folded = html(
    <SettingRow
      id="how"
      label="How your mail is used"
      paletteId="setting.ai.how"
      disclosure={{ expanded: false, onToggle: noop, content: 'Text' }}
    />,
  );
  assert.match(folded, /data-setting-anchor="how"/);
  assert.doesNotMatch(html(<SettingRow id="plain" label="Plain" />), /data-setting-anchor/);
});

/** A minimal stand-in for the few DOM calls focusSettingRow makes, so its order of choices is tested in Node. */
function fakeRoot(
  rows: Record<string, { control?: string[]; toggle?: boolean; focusable?: string[] }>,
) {
  const log: string[] = [];
  const el = (name: string) => ({
    focus: () => log.push(`focus ${name}`),
  });
  const root = {
    querySelectorAll: () =>
      Object.keys(rows).map(anchor => ({
        dataset: { settingAnchor: anchor },
        scrollIntoView: () => log.push(`scroll ${anchor}`),
        querySelector: (selector: string) => {
          const row = rows[anchor];
          if (selector === '.ui-setting-row__control')
            return row.control
              ? { querySelector: () => (row.control!.length ? el(`${anchor} control`) : null) }
              : null;
          if (selector === '.ui-setting-row__toggle')
            return row.toggle ? el(`${anchor} toggle`) : null;
          return row.focusable?.length ? el(`${anchor} first`) : null;
        },
      })),
  };
  return { root: root as unknown as ParentNode, log };
}

test('focusSettingRow scrolls to the row and focuses its control, then its toggle, then its first control', () => {
  const { root, log } = fakeRoot({
    undoSeconds: { control: ['switch'], toggle: true },
    folded: { toggle: true, focusable: ['x'] },
    plain: { focusable: ['x'] },
  });
  assert.equal(focusSettingRow('undoSeconds', root), true);
  assert.deepEqual(log.splice(0), ['scroll undoSeconds', 'focus undoSeconds control']);
  assert.equal(focusSettingRow('folded', root), true);
  assert.deepEqual(log.splice(0), ['scroll folded', 'focus folded toggle']);
  assert.equal(focusSettingRow('plain', root), true);
  assert.deepEqual(log.splice(0), ['scroll plain', 'focus plain first']);
});

test('focusSettingRow reports an unknown anchor and does nothing', () => {
  const { root, log } = fakeRoot({ undoSeconds: { control: ['switch'] } });
  assert.equal(focusSettingRow('nope', root), false);
  assert.deepEqual(log, []);
});
