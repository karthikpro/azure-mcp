import { ErrorCode } from './types.js';

export class McpError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: unknown;
  public readonly statusCode?: number;

  public constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: unknown; statusCode?: number; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'McpError';
    this.code = code;
    if (options && 'details' in options) {
      this.details = options.details;
    }
    if (typeof options?.statusCode === 'number') {
      this.statusCode = options.statusCode;
    }
  }
}

export const asMcpError = (error: unknown): McpError => {
  if (error instanceof McpError) {
    return error;
  }

  if (error instanceof Error) {
    return new McpError('INTERNAL_ERROR', error.message, { cause: error });
  }

  return new McpError('INTERNAL_ERROR', 'Unexpected error', { details: error });
};
