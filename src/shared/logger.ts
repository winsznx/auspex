/** Process-wide structured logger. Level from LOG_LEVEL (default info). */
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || 'info',
  base: { service: 'auspex' },
});

export type Logger = typeof logger;
