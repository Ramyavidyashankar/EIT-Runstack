// src/hooks/useNavigation.js
//
// Small helpers that make moving around RunStack keep the user's place:
//
//   usePersistentState(key, initial)
//     useState that survives leaving the page and coming back in the same
//     tab (sessionStorage — never localStorage, nothing shared across users
//     or written permanently). For filters, tabs and selections.
//
//   useUnsavedChanges(active, message)
//     While `active`, the sidebar asks before leaving the page and the
//     browser warns before reload/close. Use it only for work that would
//     really be lost (an unsaved form, a readiness approval held in memory).
//
//   getUnsavedChangesMessage()
//     Used by the sidebar: the message of the first active guard, or null.

import { useEffect, useRef, useState } from 'react';

const PREFIX = 'runstack.view.';

function read(key, initial) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw === null ? initial : JSON.parse(raw);
  } catch {
    return initial;
  }
}

export function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => read(key, initial));
  useEffect(() => {
    try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage unavailable — keep in memory */ }
  }, [key, value]);
  return [value, setValue];
}

const guards = new Map();
let nextId = 1;

export function useUnsavedChanges(active, message) {
  const id = useRef(null);
  if (id.current === null) id.current = nextId++;

  useEffect(() => {
    if (!active) { guards.delete(id.current); return undefined; }
    guards.set(id.current, message);
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = message; return message; };
    window.addEventListener('beforeunload', onBeforeUnload);
    const myId = id.current;
    return () => { guards.delete(myId); window.removeEventListener('beforeunload', onBeforeUnload); };
  }, [active, message]);
}

export function getUnsavedChangesMessage() {
  for (const m of guards.values()) return m;
  return null;
}
