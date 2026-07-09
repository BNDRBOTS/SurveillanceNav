/**
 * Pads an operation to a minimum wall-clock duration. Used to equalize the
 * known-account and unknown-account branches of the password-reset request
 * so response timing can't distinguish them.
 */
export async function withMinDuration<T>(minMs: number, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const remaining = minMs - (Date.now() - start);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return result;
}
