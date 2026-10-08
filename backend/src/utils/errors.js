/**
 * Typed HTTP errors. Throw these from services/routes; the central error
 * handler turns them into a consistent JSON body:
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 */
export class HttpError extends Error {
  /**
   * @param {number} status   HTTP status code
   * @param {string} code     Stable machine-readable code (clients switch on this)
   * @param {string} message  Human-readable message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message, details) => new HttpError(409, 'CONFLICT', message, details);
export const unprocessable = (message, details) => new HttpError(422, 'UNPROCESSABLE', message, details);

/** PostgreSQL SQLSTATE codes we translate into 4xx responses. */
export const PG = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  INVALID_TEXT_REPRESENTATION: '22P02',
});
