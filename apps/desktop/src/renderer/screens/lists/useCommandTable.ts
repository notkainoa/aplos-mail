/**
 * The seam between a screen and the CommandRegistry. A screen builds a table of handlers (`commandsFor<Screen>`) and
 * attaches it through a `Register` function: today `registry.attach`, tomorrow the shell's registry hook, so wiring is a
 * one-line change. Attaching is stacked per command, so detaching hands each command back to what held it before.
 */
import { useEffect, useRef } from 'react';
import type { CommandHandlers, Registry } from '../../commands';

/** The handlers a screen attaches, by command id. */
export type CommandTable = Readonly<Record<string, CommandHandlers>>;

/** Attaches one command's handlers and returns the function that detaches them (`Registry['attach']`). */
export type Register = (id: string, handlers: CommandHandlers) => () => void;

/** A registry's `attach` as a `Register`. */
export function registerOn(registry: Pick<Registry, 'attach'>): Register {
  return (id, handlers) => registry.attach(id, handlers);
}

/** Attaches every entry; returns the function that detaches them all. */
export function attachTable(register: Register, table: CommandTable): () => void {
  const detach = Object.entries(table).map(([id, handlers]) => register(id, handlers));
  return () => detach.forEach(fn => fn());
}

/**
 * Attaches `table` while mounted. The handlers read the latest table through a ref, so a table rebuilt every render
 * attaches once per `register`, not once per render.
 */
export function useCommandTable(register: Register, table: CommandTable): void {
  const latest = useRef(table);
  useEffect(() => {
    latest.current = table;
  });
  useEffect(() => {
    const forwarding = Object.fromEntries(
      Object.keys(latest.current).map(id => [id, forward(latest, id)]),
    );
    return attachTable(register, forwarding);
  }, [register]);
}

function forward(latest: { current: CommandTable }, id: string): CommandHandlers {
  return {
    run: ctx => latest.current[id]?.run(ctx),
    when: ctx => latest.current[id]?.when?.(ctx) ?? true,
  };
}
