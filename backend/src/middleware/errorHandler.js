/**
 * Last-resort error handler. Every error leaves the API in one shape:
 *   { "error": { "code", "message", "details"?, "request_id" } }
 *
 * Known PostgreSQL constraint violations become 4xx. Anything unexpected is
 * logged with full detail and returned as an opaque 500.
 */
import { HttpError, PG } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}`, request_id: req.id },
  });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let httpErr = err;

  if (!(err instanceof HttpError)) {
    if (err?.type === 'entity.parse.failed') {
      httpErr = new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    } else if (err?.type === 'entity.too.large') {
      httpErr = new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    } else if (err?.code === PG.UNIQUE_VIOLATION) {
      httpErr = new HttpError(409, 'DUPLICATE', 'A record with the same unique value already exists', {
        constraint: err.constraint,
      });
    } else if (err?.code === PG.FOREIGN_KEY_VIOLATION) {
      httpErr = new HttpError(422, 'INVALID_REFERENCE', 'A referenced record does not exist', {
        constraint: err.constraint,
      });
    } else if (err?.code === PG.CHECK_VIOLATION || err?.code === PG.INVALID_TEXT_REPRESENTATION) {
      httpErr = new HttpError(422, 'INVALID_VALUE', 'A value failed a database constraint', {
        constraint: err.constraint,
      });
    }
  }

  if (httpErr instanceof HttpError) {
    if (httpErr.status >= 500) logger.error(httpErr.message, { request_id: req.id, code: httpErr.code });
    return res.status(httpErr.status).json({
      error: { code: httpErr.code, message: httpErr.message, details: httpErr.details, request_id: req.id },
    });
  }

  logger.error('Unhandled error', { request_id: req.id, error: err?.message, stack: err?.stack });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', request_id: req.id },
  });
}
