import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { passwordStrength, fmtBytes, fmtMoney, truncate } from '@/lib/format';

describe('format helpers', () => {
  it('password strength scales 0→4', () => {
    expect(passwordStrength('')).toBe(0);
    expect(passwordStrength('short')).toBe(0);
    expect(passwordStrength('longenough')).toBe(1);
    expect(passwordStrength('LongEnough123!xx')).toBe(4);
  });
  it('bytes/money/truncate behave', () => {
    expect(fmtBytes(500)).toBe('500 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtMoney(1250000)).toContain('1,250,000');
    expect(fmtMoney(null)).toBe('—');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('parses the error envelope into ApiError', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Slow down', retryAfterSec: 30 } }), {
        status: 429,
      }),
    );
    const { api, ApiError } = await import('@/lib/api');
    await expect(api('/assets')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'rate_limited',
      status: 429,
      retryAfterSec: 30,
    });
    expect(new ApiError(0, 'network', 'x')).toBeInstanceOf(Error);
  });

  it('retries GETs on network failure with backoff, then succeeds', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { api } = await import('@/lib/api');
    const result = await api<{ ok: boolean }>('/health/live');
    expect(result.ok).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('does not retry mutations on network failure (no duplicate writes)', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockRejectedValue(new TypeError('network down'));
    const { api } = await import('@/lib/api');
    await expect(api('/assets', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'network' });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
