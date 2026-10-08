/**
 * Minimal structured (JSON-lines) logger. Swap for pino/winston without
 * touching call sites: the interface is logger.{debug,info,warn,error}(msg, meta).
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;

function write(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const logger = {
  debug: (msg, meta = {}) => write('debug', msg, meta),
  info: (msg, meta = {}) => write('info', msg, meta),
  warn: (msg, meta = {}) => write('warn', msg, meta),
  error: (msg, meta = {}) => write('error', msg, meta),
};
