/**
 * Haptic feedback wrappers (mobile). Respects OS settings implicitly via the
 * Vibration API and the user's reduced-motion preference explicitly.
 */
function canVibrate(): boolean {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return false;
  if (document.documentElement.dataset.motion === 'reduced') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  return true;
}

export const haptics = {
  /** Light tap — primary actions (buttons, toggles). */
  light(): void {
    if (canVibrate()) navigator.vibrate(8);
  },
  /** Medium tap — destructive confirmations. */
  medium(): void {
    if (canVibrate()) navigator.vibrate(22);
  },
  /** Success pattern — sync completion, exports ready. */
  success(): void {
    if (canVibrate()) navigator.vibrate([10, 40, 14]);
  },
  /** Error pattern. */
  error(): void {
    if (canVibrate()) navigator.vibrate([28, 60, 28]);
  },
};
