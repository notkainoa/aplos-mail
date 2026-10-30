/**
 * Key layers: extra contexts and conditions a mounted screen adds on top of the shell's own stack (Home's Low importance
 * sheet puts `lowImportance` on top; its "Remind me" offer sets the `remindOffer` condition). The shell's key listener
 * and key-hint providers read the stack through `shellStack`.
 */
import { createStore } from './store-core';
import type { ConditionState, ContextName } from '../commands';

/** What one mounted component contributes to the key stack. */
export interface KeyLayer {
  readonly contexts?: readonly ContextName[];
  readonly conditions?: ConditionState;
}

const layerStore = createStore<readonly KeyLayer[]>([]);

/** Adds a layer above the existing ones; returns the function that removes it. */
export function addKeyLayer(layer: KeyLayer): () => void {
  layerStore.set([...layerStore.get(), layer]);
  return () => layerStore.set(layerStore.get().filter(l => l !== layer));
}

/** The stack: global, the screen's context, every layer's contexts in mount order, and the sheet's modal context last. */
export function shellStack(
  screen: ContextName | null,
  sheetOpen: boolean,
  layers: readonly KeyLayer[],
): readonly ContextName[] {
  const stack: ContextName[] = screen ? ['global', screen] : ['global'];
  for (const layer of layers) stack.push(...(layer.contexts ?? []));
  if (sheetOpen) stack.push('sheet');
  return stack;
}

/** Every layer's conditions, later layers winning. */
export function layerConditions(layers: readonly KeyLayer[]): ConditionState {
  return Object.assign({}, ...layers.map(l => l.conditions ?? {}));
}

export const getKeyLayers = layerStore.get;
export const subscribeKeyLayers = layerStore.subscribe;
