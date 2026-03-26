import pino, { Logger } from 'pino';

export const createLogger = (level: string): Logger =>
  pino({
    level,
    base: {
      service: 'azure-devops-mcp',
      version: '0.1.0',
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        'authorization',
        'pat',
        'token',
        'accessToken',
        'clientSecret',
      ],
      censor: '[REDACTED]',
    },
  });
