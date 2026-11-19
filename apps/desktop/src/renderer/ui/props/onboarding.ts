import type { ReactNode } from 'react';
import type { CommandAction, IconName, KeyHint, TagColor } from './shared';
import type { KeySource } from './settings';

/* ───────────────────────── onboarding ───────────────────────── */

/** A button in an onboarding step's action row or footer; at most one 'filled' per step (DESIGN §4.6, §7.11). */
export interface StepButton extends CommandAction {
  /** 'filled' = the step's main action (Return, size 'lg' in the body); 'text' = quiet verbs ("Skip for now", "Back"). */
  emphasis: 'filled' | 'text';
  /** Where the keycap shows; filled Return is 'always', footer Esc is 'hint'. */
  keyHint?: KeyHint;
  /** Disabled, e.g. "Open Aplos" before the newest batch is in. */
  disabled?: boolean;
  /** Working; label stays, Spinner after 150 ms. */
  busy?: boolean;
}

/** The onboarding footer: step dashes, the fixed note, then the step's buttons (DESIGN §7.11, §7.12). */
export interface OnboardingFooter {
  /** Short dashes for "Step 2 of 4"; omitted on the first-sync screen. */
  dashes?: { step: number; of: number };
  /** 'setupContinues' = "Setup continues in the background."; 'escOpensAplos' = Esc keycap + "opens Aplos" (first sync, drill); 'none' = nothing (Welcome: nothing has started yet). */
  note: 'setupContinues' | 'escOpensAplos' | 'none';
  /** Footer buttons, e.g. Back (Esc), "Skip setup", "Continue anyway", "Open Aplos" (Return). */
  buttons: readonly StepButton[];
}

/** One onboarding step in the separate 640 × 600 window: full-bleed white, the 48 px strip with "Try demo mail", a top-anchored sans `heading` title (Welcome: centred `display`), a lede, the body, an action row and the footer (DESIGN §7.11, §7.12). Mockups: onboarding-welcome.html, onboarding-accounts.html, onboarding-ai.html, onboarding-permissions.html, onboarding-sync.html, onboarding-drill.html. Plain: ui-foundation; refines: ui-onboard. */
export interface OnboardingStepProps {
  /** 'step' = top-anchored heading; 'welcome' = centred `display` line with `safe center`. */
  layout: 'step' | 'welcome';
  /** Step title, e.g. "Add your mail", "Waiting for Google in your browser…", "Getting your mail". */
  title: string;
  /** DOM id of the title; it labels the window body. */
  titleId: string;
  /** One sentence under the title (`base` `--dim`). */
  lede?: string;
  /** Step content: TextField, ChoiceRows, ConsentCard, ProgressSegments, Text. */
  children?: ReactNode;
  /** "More options" disclosure for steps with more than about six controls. */
  moreOptions?: { expanded: boolean; onToggle: () => void; content: ReactNode };
  /** The action row under the content, e.g. "Continue with Google" (filled, Return) + "Use a different provider". */
  actions?: readonly StepButton[];
  /** The footer. */
  footer: OnboardingFooter;
  /** "Try demo mail" in the top strip, with the tooltip "Load sample mail to look around. Remove it any time in Settings." Omit to hide. */
  onTryDemo?: () => void;
  /** Phase text for the one visually hidden `role="status"` (first sync: connected, found, ready, failed; DESIGN §7.12). */
  phaseStatus?: string;
}

/** A quiet onboarding row: provider choice ("Google ›"), a found provider, a connected account, an AI provider radio ("Groq · Default", key source, "Works · 0.4 s", Test), a permission (Microphone · Allow…, a Switch) (DESIGN §7.11). Mockups: onboarding-accounts.html (`.row-q`), onboarding-ai.html (`.blk .it`), onboarding-permissions.html (`.perm`). Plain: ui-foundation; refines: ui-onboard. */
export interface ChoiceRowProps {
  /** DOM id. */
  id: string;
  /** 'link' = the whole row is a button that goes on (chevron); 'radio' = one of a radiogroup; 'static' = information with an optional trailing control. */
  role: 'link' | 'radio' | 'static';
  /** Name, e.g. "Google", "Groq", "Microphone", "alex.moreno@gmail.com". */
  label: string;
  /** Leading icon. */
  icon?: IconName;
  /** Leading account dot instead of an icon. */
  mark?: TagColor;
  /** Quiet tag after the label, e.g. "Default". */
  tag?: string;
  /** Second line, e.g. "You sign in on Google's own page in your browser.", "Google", "Hold A to dictate to Ask…". */
  detail?: string;
  /** A provider's key source as the second line ("Key found in the environment as GROQ_API_KEY", mono variable); replaces `detail`. */
  keySource?: KeySource;
  /** A small status dot before the detail: 'ok' = found/running, 'off' = not running. */
  detailDot?: 'ok' | 'off';
  /** Trailing status word: 'ok' adds a check ("Found", "Connected", "Allowed", "Works · 0.4 s"); 'attention' an alert in `--stamp-ink`. */
  status?: { text: string; tone: 'ok' | 'dim' | 'attention' };
  /** Trailing control: Test or "Allow…" Button (size 'sm'), a model picker, a Switch. */
  control?: ReactNode;
  /** Radio only: chosen (`aria-checked`). */
  selected?: boolean;
  /** Link or radio press. */
  onPress?: () => void;
}

/** A radio group of ChoiceRows (role 'radio'), e.g. the onboarding AI provider choice: owns `role="radiogroup"`, the roving tabindex and ↑/↓ (WAI-ARIA radio group); the rows only report presses. Segmented choices use Puck (role 'radio'); pickers use Button + Menu (README) (DESIGN §7.11; gap list O16, U10). Mockups: onboarding-ai.html (`.blk .it`). Plain: ui-foundation; refines: ui-onboard. */
export interface ChoiceGroupProps {
  /** Accessible name of the radiogroup, e.g. "AI provider". */
  label: string;
  /** DOM id of a visible label; overrides `label` as the name. */
  labelledBy?: string;
  /** The chosen row's `id`; null when none is chosen. */
  value: string | null;
  /** A row was chosen (click, ↑/↓, Space). */
  onChange: (id: string) => void;
  /** ChoiceRows with role 'radio'; each row's `id` is its value and its `selected` mirrors `value`. */
  children: ReactNode;
}

/** The AI step's one card (`--elev-card`): Provider, Model and "What is sent", then Allow (filled, Return) and "Not now"; background summaries wait for it (DESIGN §7.11; plan 30 §4.5 #1). Mockups: onboarding-ai.html (consent). Plain: ui-foundation; refines: ui-onboard; also used by ui-settings when the provider changes. */
export interface ConsentCardProps {
  /** Provider display name, e.g. "Groq". */
  provider: string;
  /** Model id, e.g. "llama-3.3-70b-versatile". */
  model: string;
  /** What is sent, one plain sentence ("The sender, subject and text of each new email… Attachments are not sent."). */
  sent: string;
  /** Adds the lock line "Ollama and LM Studio keep all of this on your Mac." when a hosted provider is chosen. */
  showLocalNote?: boolean;
  /** Allow (Return). */
  onAllow: () => void;
  /** Not now. */
  onNotNow: () => void;
}
