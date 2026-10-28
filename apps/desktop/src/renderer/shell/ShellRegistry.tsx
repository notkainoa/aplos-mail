/**
 * The one CommandRegistry for the app. `KeysProviders` creates it and puts it in this context; a screen calls
 * `useShellRegistry().register(handlers)` while it is mounted. The registry runs the newest handler for a command, so a
 * later registration shadows an earlier one until it is unregistered.
 */
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { createAppRegistry, type CommandHandlers, type Registry } from '../commands';

/** Handlers keyed by command id. */
export type CommandHandlerTable = Readonly<Record<string, CommandHandlers>>;

/** The shared registry and the way a screen adds its handlers to it. */
export interface ShellRegistry {
  readonly registry: Registry;
  /** Attaches every handler; returns the function that detaches them all. An unknown command id throws and attaches nothing. */
  register(handlers: CommandHandlerTable): () => void;
}

/** Wraps a registry in the shell's `register` API. */
export function shellRegistryFor(registry: Registry): ShellRegistry {
  return {
    registry,
    register(handlers) {
      const detached: (() => void)[] = [];
      try {
        for (const [id, h] of Object.entries(handlers)) detached.push(registry.attach(id, h));
      } catch (error) {
        detached.forEach(detach => detach());
        throw error;
      }
      return () => detached.forEach(detach => detach());
    },
  };
}

const RegistryContext = createContext<ShellRegistry | null>(null);
let fallback: ShellRegistry | null = null;

/** Mounts a registry for `useShellRegistry` below it. */
export function ShellRegistryProvider(props: {
  readonly value: ShellRegistry;
  readonly children: ReactNode;
}) {
  return <RegistryContext.Provider value={props.value}>{props.children}</RegistryContext.Provider>;
}

/** The shared registry. Outside a shell (a screen under test) it is one module-level registry, so screens still mount. */
export function useShellRegistry(): ShellRegistry {
  const mounted = useContext(RegistryContext);
  if (mounted) return mounted;
  fallback ??= shellRegistryFor(createAppRegistry());
  return fallback;
}

/** Registers `handlers` for the calling component's lifetime. Pass a stable (memoised) table; a new one re-registers. */
export function useRegisterCommands(handlers: CommandHandlerTable): void {
  const shell = useShellRegistry();
  useEffect(() => shell.register(handlers), [shell, handlers]);
}
