/**
 * Zod validation middleware. Parsed (coerced, trimmed, defaulted) values are
 * stored on req.valid.{body,query} so handlers never touch raw input.
 */
import { badRequest } from '../utils/errors.js';

function formatIssues(error) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export const validateBody = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) return next(badRequest('Request body is invalid', formatIssues(result.error)));
  req.valid = { ...req.valid, body: result.data };
  next();
};

export const validateQuery = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) return next(badRequest('Query string is invalid', formatIssues(result.error)));
  req.valid = { ...req.valid, query: result.data };
  next();
};
