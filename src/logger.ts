import pino from 'pino';

import type { AppConfig } from './config.js';

export function createLogger(config: AppConfig) {
  return pino({
    level: config.logLevel,
    base: {
      service: 'bstock-monitor',
      pid: process.pid,
    },
    redact: {
      paths: [
        'binanceApiKey',
        'binanceApiSecret',
        'webhookUrl',
        'feishuWebhookUrl',
        'feishuWebhookSecret',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
    ...(config.nodeEnv === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard', singleLine: true },
          },
        }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
