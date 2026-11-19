/**
 * Step 4, Voice and permissions (DESIGN 7.11 step 4, 8, 10; onboarding-permissions.html default, granted).
 * Microphone, notifications and open at login as quiet rows; holding A and holding R explained in one line each;
 * every row is optional and "Finish setup" always goes on. Nothing here can block the owner: a denied permission
 * offers System Settings, an unavailable one says so, and a failed call leaves the row as it was.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSettings } from '../../data';
import type { Input, Output } from '../../data';
import { backFooter, MAIN_LABEL, missingMethod, type StepChrome, type StepKeys } from '../flow';
import { ChoiceRow, OnboardingStep } from '../../ui/onboarding';
import { WindowNoticeLine } from '../WindowNotice';
import { Button } from '../../ui/buttons-keys';
import { Switch } from '../../ui/controls';

/** A macOS permission as the row shows it. */
export type PermissionState = 'unknown' | 'notDetermined' | 'granted' | 'denied' | 'unavailable';

export interface PermissionsStepProps {
  readonly chrome: StepChrome;
  readonly microphone: PermissionState;
  readonly notifications: PermissionState;
  /** Open at login; undefined while unknown or unavailable. */
  readonly openAtLogin: boolean | undefined;
  /** The Voice provider's name, for "Speech goes to Groq to become text." */
  readonly voiceProvider?: string;
  /** A request is in flight. */
  readonly asking?: 'microphone' | 'notifications';
  readonly onAllow: (kind: 'microphone' | 'notifications') => void;
  readonly onOpenSettings: (pane: 'microphone' | 'notifications') => void;
  readonly onOpenAtLogin: (enabled: boolean) => void;
  readonly onFinish: () => void;
}

/** "Hold A …" and "Hold R …", one line each (DESIGN 8: hold A dictates to Ask, hold R dictates a reply; 10). */
export const HOLD_LINES = ['Hold A to dictate to Ask.', 'Hold R to dictate a reply.'] as const;

/** The Voice provider's display name for the speech line. */
export function voiceName(provider: string | undefined): string | undefined {
  if (provider === 'groq') return 'Groq';
  if (provider === 'openai') return 'OpenAI';
  return undefined;
}

/** Where to turn a blocked permission back on: plain words, one sentence (DESIGN 7.11 step 4; 8 "say what to do"). */
export const DENIED_LINES = {
  microphone:
    'macOS has blocked the microphone. Turn it on for Aplos in System Settings, under Privacy & Security.',
  notifications:
    'macOS has blocked notifications. Turn them on for Aplos in System Settings, under Notifications.',
} as const;

export function microphoneDetail(
  voiceProvider: string | undefined,
  state?: PermissionState,
): string {
  if (state === 'denied') return `${HOLD_LINES[0]} ${HOLD_LINES[1]} ${DENIED_LINES.microphone}`;
  const speech = voiceProvider ? ` Speech goes to ${voiceProvider} to become text.` : '';
  return `${HOLD_LINES[0]} ${HOLD_LINES[1]}${speech}`;
}

export const NOTIFICATIONS_DETAIL =
  'Only for mail that reaches Home. Newsletters and receipts stay quiet.';

export function notificationsDetail(state?: PermissionState): string {
  return state === 'denied'
    ? `${NOTIFICATIONS_DETAIL} ${DENIED_LINES.notifications}`
    : NOTIFICATIONS_DETAIL;
}

function permissionEnd(
  kind: 'microphone' | 'notifications',
  state: PermissionState,
  asking: boolean,
  props: Pick<PermissionsStepProps, 'onAllow' | 'onOpenSettings'>,
) {
  switch (state) {
    case 'granted':
      return { status: { text: 'Allowed', tone: 'ok' as const } };
    case 'denied':
      return {
        status: { text: 'Turned off', tone: 'dim' as const },
        control: (
          <Button
            variant="text"
            size="sm"
            label="Open System Settings"
            onPress={() => props.onOpenSettings(kind)}
          />
        ),
      };
    case 'unavailable':
      return { status: { text: 'Not available here', tone: 'dim' as const } };
    default:
      return {
        control: (
          <Button
            variant="text"
            size="sm"
            label="Allow…"
            busy={asking}
            onPress={() => props.onAllow(kind)}
          />
        ),
      };
  }
}

export function PermissionsStep(props: PermissionsStepProps) {
  const { chrome } = props;
  return (
    <OnboardingStep
      layout="step"
      title="Voice and permissions"
      titleId="onb-title"
      lede="Each of these is optional. Aplos works without them, and you can change any of them later in Settings."
      actions={[
        {
          label: MAIN_LABEL.permissions,
          emphasis: 'filled',
          keys: 'Return',
          keyHint: 'always',
          onSelect: props.onFinish,
        },
      ]}
      footer={backFooter(chrome)}
      {...(chrome.status ? { phaseStatus: chrome.status } : {})}
    >
      <div className="onb-rows" role="group" aria-label="Permissions">
        <ChoiceRow
          id="onb-perm-microphone"
          role="static"
          icon="mic"
          label="Microphone"
          detail={microphoneDetail(props.voiceProvider, props.microphone)}
          {...permissionEnd('microphone', props.microphone, props.asking === 'microphone', props)}
        />
        <ChoiceRow
          id="onb-perm-notifications"
          role="static"
          icon="bell"
          label="Notifications"
          detail={notificationsDetail(props.notifications)}
          {...permissionEnd(
            'notifications',
            props.notifications,
            props.asking === 'notifications',
            props,
          )}
        />
        <ChoiceRow
          id="onb-perm-login"
          role="static"
          icon="laptop"
          label="Open Aplos when you log in"
          detail="Your mail is ready when you sit down."
          {...(props.openAtLogin === undefined
            ? { status: { text: 'Not available here', tone: 'dim' as const } }
            : {
                control: (
                  <Switch
                    checked={props.openAtLogin}
                    label="Open Aplos when you log in"
                    onChange={props.onOpenAtLogin}
                  />
                ),
              })}
        />
      </div>
      <WindowNoticeLine notice={chrome.notice} />
    </OnboardingStep>
  );
}

/* ---------- Container ---------- */

/** Main's native permission calls. Defaults come from `renderer/data`; the preview and tests pass their own. */
export interface SystemPorts {
  microphone(input: Input<'System/microphone'>): Promise<Output<'System/microphone'>>;
  notifications(): Promise<Output<'System/notifications'>>;
  /** Posting one notification is how macOS asks for permission the first time. */
  notificationTest(): Promise<unknown>;
  login(input: Input<'System/login'>): Promise<Output<'System/login'>>;
  openSettings(input: Input<'System/openSettings'>): Promise<unknown>;
}

// REQUEST ui-shell / eng-host: `System/microphone`, `System/notifications`, `System/login`, `System/openSettings`
// and `Notification/test` are desktop methods that `renderer/data`'s api does not expose yet. Until then every row
// shows "Allow…" and Finish setup still goes on.
export const defaultSystemPorts: SystemPorts = {
  microphone: async () => {
    throw missingMethod('System/microphone');
  },
  notifications: async () => {
    throw missingMethod('System/notifications');
  },
  notificationTest: async () => {
    throw missingMethod('Notification/test');
  },
  login: async () => {
    throw missingMethod('System/login');
  },
  openSettings: async () => {
    throw missingMethod('System/openSettings');
  },
};

/** macOS's microphone status words → the row's state. */
export function micState(out: Output<'System/microphone'>): PermissionState {
  if (out.granted) return 'granted';
  if (out.status === 'denied' || out.status === 'restricted') return 'denied';
  if (out.status === 'not-determined' || out.status === 'notDetermined') return 'notDetermined';
  return 'unknown';
}

export function notificationState(out: Output<'System/notifications'>): PermissionState {
  switch (out.status) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'notDetermined':
      return 'notDetermined';
    default:
      return 'unknown';
  }
}

export interface PermissionsContainerProps {
  readonly chrome: StepChrome;
  readonly bindKeys: (keys: StepKeys) => void;
  readonly onFinish: () => void;
  readonly ports?: Partial<SystemPorts>;
}

export function PermissionsContainer({
  chrome,
  bindKeys,
  onFinish,
  ports: given,
}: PermissionsContainerProps) {
  const ports = useRef({ ...defaultSystemPorts, ...given }).current;
  const settings = useSettings();
  const [microphone, setMicrophone] = useState<PermissionState>('unknown');
  const [notifications, setNotifications] = useState<PermissionState>('unknown');
  // Off until main answers; a row whose check fails says "Not available here" instead of offering a dead control.
  const [openAtLogin, setOpenAtLogin] = useState<boolean | undefined>(false);
  const [asking, setAsking] = useState<'microphone' | 'notifications' | undefined>(undefined);

  useEffect(() => {
    let live = true;
    ports
      .microphone({ check: true })
      .then(out => live && setMicrophone(micState(out)))
      .catch(() => live && setMicrophone('unavailable'));
    ports
      .notifications()
      .then(out => live && setNotifications(notificationState(out)))
      .catch(() => live && setNotifications('unavailable'));
    ports
      .login({})
      .then(out => live && setOpenAtLogin(out.enabled))
      .catch(() => live && setOpenAtLogin(undefined));
    return () => {
      live = false;
    };
  }, [ports]);

  const onAllow = useCallback(
    async (kind: 'microphone' | 'notifications') => {
      setAsking(kind);
      try {
        if (kind === 'microphone') setMicrophone(micState(await ports.microphone({})));
        else {
          await ports.notificationTest();
          setNotifications(notificationState(await ports.notifications()));
        }
      } catch {
        // The row stays as it was; the step is optional and Finish setup goes on.
      } finally {
        setAsking(undefined);
      }
    },
    [ports],
  );

  const onOpenAtLogin = useCallback(
    async (enabled: boolean) => {
      setOpenAtLogin(enabled);
      try {
        setOpenAtLogin((await ports.login({ enabled })).enabled);
      } catch {
        setOpenAtLogin(!enabled);
      }
    },
    [ports],
  );

  useLayoutEffect(() =>
    bindKeys({
      focusKey: 'permissions',
      focus: { kind: 'button', label: MAIN_LABEL.permissions },
      main: onFinish,
    }),
  );

  return (
    <PermissionsStep
      chrome={chrome}
      microphone={microphone}
      notifications={notifications}
      openAtLogin={openAtLogin}
      asking={asking}
      {...(voiceName(settings?.ai.features.voice.provider)
        ? { voiceProvider: voiceName(settings?.ai.features.voice.provider) }
        : {})}
      onAllow={kind => void onAllow(kind)}
      onOpenSettings={pane => void ports.openSettings({ pane }).catch(() => {})}
      onOpenAtLogin={enabled => void onOpenAtLogin(enabled)}
      onFinish={onFinish}
    />
  );
}
