/** Typed application errors mapped to the consistent API error envelope. */

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
    public retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details);
export const payloadTooLarge = (message = 'Payload too large') =>
  new AppError(413, 'payload_too_large', message);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'validation_failed', message, details);
export const tooManyRequests = (retryAfterSec: number) =>
  new AppError(
    429,
    'rate_limited',
    `Too many requests — please slow down. Try again in about ${retryAfterSec}s.`,
    undefined,
    retryAfterSec,
  );
export const serviceUnavailable = (message = 'Temporary service degradation — please retry shortly') =>
  new AppError(503, 'service_unavailable', message, undefined, 5);
