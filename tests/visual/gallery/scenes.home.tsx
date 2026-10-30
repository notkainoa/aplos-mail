// ui-home scenes: Home, Later, the shared lists and Done, drawn as the real screens inside the real app on the
// stand-in engine (the `demo` scenario, the fixture's clock on the frozen wall clock). Each state names a scenario, a
// screen and a few steps (a key, a click, a drag) that run once the screen has content. The page holds the screenshot
// back (`data-gallery-pending`, read by main.tsx) until the screen has painted and the steps have run.

import { useEffect, useRef, type ReactElement } from 'react';
import { createClient } from '@aplos/contract/client';
import type { Scenario } from '@aplos/contract-fixture';
import { App, type AppClient } from '../../../apps/desktop/src/renderer/App';
import { connectStandInDataLayer } from '../../../apps/desktop/src/renderer/data/standin-layer';
import { api } from '../../../apps/desktop/src/renderer/data';
import { navigate, type Screen } from '../../../apps/desktop/src/renderer/shell';
import '../../../apps/desktop/src/renderer/shell/shell.css';
import '../../../apps/desktop/src/renderer/screens/screens.css';

/** One thing the scene does once the screen has painted. */
type Step =
  | { readonly key: string; readonly times?: number }
  | { readonly click: string }
  | { readonly drag: string; readonly to: string; readonly hold: boolean }
  | { readonly run: () => Promise<void> };

interface HomeScene {
  readonly scenario: Scenario;
  readonly screen: Screen;
  readonly steps?: readonly Step[];
}

/* ------------------------------ the booted app ------------------------------ */

let booted: AppClient | null = null;

/** One stand-in per page load (the harness opens one state per page); the fixture clock is the wall clock, frozen by the spec. */
function boot(scenario: Scenario): AppClient {
  if (booted) return booted;
  const layer = connectStandInDataLayer({ scenario, clock: 'real' });
  booted = createClient(layer.engine.connect());
  return booted;
}

const FRAME_LIMIT = 240;

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await nextFrame();
}

/** Waits for the screen slot to have content past its first paint (a list, the Home groups, an empty line). */
async function untilPainted(): Promise<void> {
  for (let i = 0; i < FRAME_LIMIT; i += 1) {
    const slot = document.querySelector('.aplos-screen');
    if (slot && slot.querySelector('[role="listbox"], [role="status"], p, h1, h2')) break;
    await nextFrame();
  }
  await frames(12);
}

function point(element: Element): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

function pointer(type: string, at: { x: number; y: number }): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: at.x,
    clientY: at.y,
  });
}

/** Lifts a row and moves it onto another element; with `hold` the pointer stays down, so the ghost is on show. */
async function drag(from: string, to: string, hold: boolean): Promise<void> {
  // A synthetic pointer is not one the browser knows, so capturing it would throw.
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  const source = document.querySelector(from);
  const target = document.querySelector(to);
  if (!source || !target) return;
  const start = point(source);
  const end = point(target);
  source.dispatchEvent(pointer('pointerdown', start));
  await frames(2);
  for (const t of [0.25, 0.5, 0.75, 1]) {
    const at = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
    (document.elementFromPoint(at.x, at.y) ?? source).dispatchEvent(pointer('pointermove', at));
    await frames(2);
  }
  if (!hold) target.dispatchEvent(pointer('pointerup', end));
  await frames(6);
}

async function runStep(step: Step): Promise<void> {
  if ('key' in step) {
    for (let i = 0; i < (step.times ?? 1); i += 1) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, bubbles: true }));
      await frames(2);
    }
  } else if ('click' in step) {
    document.querySelector<HTMLElement>(step.click)?.click();
  } else if ('drag' in step) {
    await drag(step.drag, step.to, step.hold);
  } else {
    await step.run();
  }
  await frames(8);
  // The engine's frames land on timers, not frames.
  await new Promise(resolve => setTimeout(resolve, 400));
}

function Pending(): ReactElement {
  return <div hidden data-gallery-pending="" />;
}

function useScene(scene: HomeScene): AppClient {
  const client = boot(scene.scenario);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void (async () => {
      await untilPainted();
      for (const step of scene.steps ?? [])
        await runStep(step).catch((error: unknown) => console.error('gallery step failed', error));
      document.querySelector('[data-gallery-pending]')?.removeAttribute('data-gallery-pending');
    })();
  }, [scene]);
  return client;
}

function sceneOf(scene: HomeScene): () => ReactElement {
  return function HomeStateScene(): ReactElement {
    navigate(scene.screen);
    const client = useScene(scene);
    return (
      <>
        <App client={client} />
        <Pending />
      </>
    );
  };
}

/* ------------------------------ steps ------------------------------ */

type ActionBody = Parameters<typeof api.thread.act>[0]['action'];
type ViewSpec = Parameters<AppClient['api']['view']['watch']>[0]['spec'];

/**
 * Applies one action to every thread a view holds. The ids come from a window on the second connection; the write goes
 * through the app's own data layer, so the screen's windows follow it exactly as they follow a key.
 */
function actOnView(spec: ViewSpec, action: ActionBody): Step {
  return {
    run: async () => {
      const client = boot('demo');
      const window = await client.api.view.watch({ spec });
      const { receipt } = api.thread.act({ ids: window.ids, action });
      await receipt.catch((error: unknown) => console.error('gallery act failed', error));
      await client.api.view.unwatch({ windowId: window.windowId });
    },
  };
}

/** Home with nothing left: every thread it holds, the Low importance band and Follow up included, is Done. */
const CLEAR_HOME: readonly Step[] = [
  actOnView({ kind: 'home' }, { type: 'done' }),
  actOnView({ kind: 'homeSection', section: 'low' }, { type: 'done' }),
  actOnView({ kind: 'homeSection', section: 'follow' }, { type: 'replyStatus', status: 'none' }),
];

const LABEL = { label: 'demo-work:label-projects' } as const;
const NO_MAIL = { label: 'demo-work:label-nothing-here' } as const;
const LATER_ROW = '.aplos-screen [role="option"]';

/* ------------------------------ the scenes ------------------------------ */

export const homeScenes: Record<string, () => ReactElement> = {
  'home-full': sceneOf({ scenario: 'demo', screen: 'home' }),
  'home-with-cursor-focusslot': sceneOf({
    scenario: 'demo',
    screen: 'home',
    steps: [{ key: 'j', times: 3 }],
  }),
  'home-inbox-zero': sceneOf({
    scenario: 'demo',
    screen: 'home',
    steps: CLEAR_HOME,
  }),
  'home-first-sync': sceneOf({
    scenario: 'backfilling',
    screen: 'home',
    steps: CLEAR_HOME,
  }),
  'home-low-sheet': sceneOf({ scenario: 'demo', screen: 'home', steps: [{ click: '#home-low' }] }),
  'home-do-now-from-later': sceneOf({
    scenario: 'demo',
    screen: 'home',
    steps: [{ key: 'j', times: 5 }],
  }),
  'home-follow-up': sceneOf({ scenario: 'demo', screen: 'home', steps: [{ key: 'j', times: 8 }] }),
  'later-groups': sceneOf({ scenario: 'demo', screen: 'later' }),
  'later-drag-ghost': sceneOf({
    scenario: 'demo',
    screen: 'later',
    steps: [{ drag: LATER_ROW, to: '#later-group-someday', hold: true }],
  }),
  'later-empty': sceneOf({
    scenario: 'demo',
    screen: 'later',
    steps: [actOnView({ kind: 'later' }, { type: 'done' })],
  }),
  'list-all-mail': sceneOf({ scenario: 'demo', screen: 'all' }),
  'list-drafts': sceneOf({ scenario: 'demo', screen: 'drafts' }),
  'list-sent': sceneOf({ scenario: 'demo', screen: 'sent' }),
  'list-trash': sceneOf({ scenario: 'demo', screen: 'trash' }),
  'list-spam': sceneOf({ scenario: 'demo', screen: 'spam' }),
  'list-label': sceneOf({ scenario: 'demo', screen: LABEL }),
  'list-empty': sceneOf({ scenario: 'demo', screen: NO_MAIL }),
  'done-screen-rows': sceneOf({ scenario: 'demo', screen: 'done' }),
  'done-empty': sceneOf({
    scenario: 'demo',
    screen: 'done',
    steps: [actOnView({ kind: 'done' }, { type: 'restore' })],
  }),
};
