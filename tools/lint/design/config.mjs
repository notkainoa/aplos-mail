// Which files the design lint covers by default, and what it never covers.
// Exempt: the token sources and generated files only (DESIGN 12.2), plus
// tests and fixtures, which plant violations on purpose. There are no inline
// disable comments.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, '../../..');

export const include = ['apps/desktop/src/renderer/**/*.{css,ts,tsx}'];

// TEMPORARY: every renderer file at this commit that still sits outside
// renderer/legacy/. Delete this whole list once restructure step 1 lands (the
// move into legacy/, which the first exclude below already covers).
export const legacyRendererFiles = [
  'apps/desktop/src/renderer/App.tsx',
  'apps/desktop/src/renderer/Ask.tsx',
  'apps/desktop/src/renderer/AskAnswer.tsx',
  'apps/desktop/src/renderer/AskEvent.tsx',
  'apps/desktop/src/renderer/Calendar.tsx',
  'apps/desktop/src/renderer/Compose.tsx',
  'apps/desktop/src/renderer/LevelMeter.tsx',
  'apps/desktop/src/renderer/Reader.tsx',
  'apps/desktop/src/renderer/Settings.tsx',
  'apps/desktop/src/renderer/bridge.ts',
  'apps/desktop/src/renderer/calendarLayout.ts',
  'apps/desktop/src/renderer/calendarMotion.ts',
  'apps/desktop/src/renderer/calendarTime.ts',
  'apps/desktop/src/renderer/components/AddAccount.tsx',
  'apps/desktop/src/renderer/components/AiSettings.tsx',
  'apps/desktop/src/renderer/components/ApiKey.tsx',
  'apps/desktop/src/renderer/components/AppIcon.tsx',
  'apps/desktop/src/renderer/components/DeviceSync.tsx',
  'apps/desktop/src/renderer/components/DomainCheck.tsx',
  'apps/desktop/src/renderer/components/MailList.tsx',
  'apps/desktop/src/renderer/components/Overlays.tsx',
  'apps/desktop/src/renderer/components/Sidebar.tsx',
  'apps/desktop/src/renderer/components/Topbar.tsx',
  'apps/desktop/src/renderer/components/Welcome.tsx',
  'apps/desktop/src/renderer/dateLabel.ts',
  'apps/desktop/src/renderer/detectedPlans.ts',
  'apps/desktop/src/renderer/icons.tsx',
  'apps/desktop/src/renderer/mailBody.ts',
  'apps/desktop/src/renderer/main.tsx',
  'apps/desktop/src/renderer/styles.css',
  'apps/desktop/src/renderer/styles/ask.css',
  'apps/desktop/src/renderer/styles/calendar.css',
  'apps/desktop/src/renderer/styles/focus.css',
  'apps/desktop/src/renderer/styles/reader.css',
  'apps/desktop/src/renderer/styles/settings-ai.css',
  'apps/desktop/src/renderer/summaries.ts',
  'apps/desktop/src/renderer/summaryText.ts',
  'apps/desktop/src/renderer/ui/Button.tsx',
  'apps/desktop/src/renderer/ui/Controls.tsx',
  'apps/desktop/src/renderer/ui/Dialog.tsx',
  'apps/desktop/src/renderer/ui/Display.tsx',
  'apps/desktop/src/renderer/ui/Kbd.tsx',
  'apps/desktop/src/renderer/ui/Menu.tsx',
  'apps/desktop/src/renderer/ui/Popover.tsx',
  'apps/desktop/src/renderer/ui/Tabs.tsx',
  'apps/desktop/src/renderer/ui/Toast.tsx',
  'apps/desktop/src/renderer/ui/Tooltip.tsx',
  'apps/desktop/src/renderer/ui/floating.ts',
  'apps/desktop/src/renderer/ui/index.ts',
  'apps/desktop/src/renderer/ui/motion.ts',
  'apps/desktop/src/renderer/ui/tokens.css',
  'apps/desktop/src/renderer/ui/ui.css',
  'apps/desktop/src/renderer/ui/useSwipe.ts',
  'apps/desktop/src/renderer/useVoice.ts',
];

export const exclude = [
  'apps/desktop/src/renderer/legacy/**',
  'apps/desktop/src/renderer/ui/tokens.json',
  'apps/desktop/src/renderer/ui/generated/**',
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/*.test.{ts,tsx,mjs}',
  '**/*.d.ts',
  ...legacyRendererFiles,
];
