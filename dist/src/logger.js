import pino from 'pino';
export const createLogger = (level) => pino({
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
