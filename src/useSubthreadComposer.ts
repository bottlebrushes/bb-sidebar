import { useSyncExternalStore } from "react";

// One composer per window. The row menu and the keyboard command both open it,
// and they live in different plugin mounts, so the target sits at module scope.
let parentThreadId: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(next: string | null) {
  if (parentThreadId === next) return;
  parentThreadId = next;
  for (const listener of listeners) listener();
}

export function openSubthreadComposer(threadId: string) {
  set(threadId);
}

export function closeSubthreadComposer() {
  set(null);
}

export function useSubthreadComposerTarget(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => parentThreadId,
    () => null,
  );
}
