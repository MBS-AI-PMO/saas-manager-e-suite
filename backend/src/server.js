/**
 * Process entry point: verify the DB, start HTTP + outbox dispatcher, and
 * shut both down gracefully on SIGINT/SIGTERM.
 */
import { createApp } from './app.js';
import { env } from './config/env.js';
import { assertDatabaseReachable, pool } from './db/pool.js';
import { startOutboxDispatcher } from './services/outboxService.js';
import { startPortalRoleRefresher } from './services/portalRoleService.js';
import { logger } from './utils/logger.js';

async function main() {
  try {
    await assertDatabaseReachable();
  } catch (err) {
    logger.error('Cannot reach PostgreSQL at startup', { error: err.message });
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => logger.info('Identity API listening', { port: env.PORT }));
  const stopDispatcher = startOutboxDispatcher();
  // Re-fetch roles from portals that own their roles (every 15 min by default).
  startPortalRoleRefresher();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    // Hard stop if something hangs.
    setTimeout(() => process.exit(1), 15_000).unref();

    server.close(async () => {
      await stopDispatcher();
      await pool.end();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', { reason: String(reason) }));
}

main();
