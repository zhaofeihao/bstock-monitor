import { MonitorApp } from './app.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { errorMessage } from './utils.js';

const logger = createLogger(config);
const app = new MonitorApp(config, logger);
let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const forceTimer = setTimeout(() => {
    logger.fatal('Graceful shutdown timed out');
    process.exit(1);
  }, 12_000);
  forceTimer.unref();
  await app.stop();
  clearTimeout(forceTimer);
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logger.fatal({ error: errorMessage(error), stack: error.stack }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (error) => {
  logger.error({ error: errorMessage(error) }, 'Unhandled promise rejection');
});

try {
  await app.start();
} catch (error) {
  logger.fatal({ error: errorMessage(error) }, 'Unable to start bStock monitor');
  await app.stop().catch(() => undefined);
  process.exit(1);
}
