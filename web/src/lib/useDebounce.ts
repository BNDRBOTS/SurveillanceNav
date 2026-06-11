import { useEffect, useRef, useState } from 'react';

/** Debounced value (spec: 150ms search debounce). */
export function useDebounce<T>(value: T, delayMs = 150): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** Debounced callback that cancels in-flight aborts between rapid calls. */
export function useAbortableEffect(
  effect: (signal: AbortSignal) => void | Promise<void>,
  deps: unknown[],
  delayMs = 0,
): void {
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => {
    ctrl.current?.abort();
    const controller = new AbortController();
    ctrl.current = controller;
    const t = setTimeout(() => void effect(controller.signal), delayMs);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
