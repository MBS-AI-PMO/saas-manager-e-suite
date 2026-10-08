/**
 * Express application (no listening here, so tests can import it).
 */
import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { assertDatabaseReachable } from './db/pool.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requireAdmin } from './middleware/requireAdmin.js';
import { authRouter } from './routes/auth.js';
import { catalogRouter } from './routes/catalog.js';
import { portalSyncRouter } from './routes/portalSync.js';
import { usersRouter } from './routes/users.js';
import { webhooksRouter } from './routes/webhooks.js';
import { getJwks } from './services/tokenService.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one reverse proxy (nginx/ALB) for correct client IPs
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  // Correlation id for logs and error responses.
  app.use((req, res, next) => {
    req.id = req.get('X-Request-Id') || crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  });

  // Keep the exact raw bytes: webhook HMACs are computed over them.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    }),
  );

  // --- Public ---------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    try {
      await assertDatabaseReachable();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unreachable' });
    }
  });
  app.get('/.well-known/jwks.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(getJwks());
  });

  // --- API v1 ---------------------------------------------------------------
  app.use('/api/v1/webhooks', webhooksRouter); // HMAC-authenticated
  app.use('/api/v1/auth', authRouter); // credential / portal authenticated
  app.use('/api/v1/portal-sync', portalSyncRouter); // portal Basic auth
  app.use('/api/v1/users', requireAdmin, usersRouter); // admin JWT
  app.use('/api/v1', requireAdmin, catalogRouter); // admin JWT

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
