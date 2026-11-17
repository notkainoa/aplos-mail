import { useEffect, useRef } from 'react';

export type KeyActions = {
  done: () => void;
  later: () => void;
  undo: () => void;
  main: () => void;
};

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function isFocusCard(target: EventTarget | null) {
  return target instanceof HTMLElement && target.hasAttribute('data-focus-card');
}

/**
 * Page-wide triage keys: → Done, ← Later, Z undo. Space only acts while focus is in the focus
 * card, so it keeps scrolling the page everywhere else. Keys typed into fields are ignored.
 */
export function useKeys(actions: KeyActions) {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isTyping(event.target)) {
        return;
      }
      const run = pick(event, ref.current);
      if (run) {
        event.preventDefault();
        run();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function pick(event: KeyboardEvent, actions: KeyActions) {
  if (event.key === 'ArrowRight') {
    return actions.done;
  }
  if (event.key === 'ArrowLeft') {
    return actions.later;
  }
  if (event.key === 'z' || event.key === 'Z') {
    return actions.undo;
  }
  if (event.key === ' ' && isFocusCard(event.target)) {
    return actions.main;
  }
  return null;
}
