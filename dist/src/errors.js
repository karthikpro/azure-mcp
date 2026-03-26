export class McpError extends Error {
    code;
    details;
    statusCode;
    constructor(code, message, options) {
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
export const asMcpError = (error) => {
    if (error instanceof McpError) {
        return error;
    }
    if (error instanceof Error) {
        return new McpError('INTERNAL_ERROR', error.message, { cause: error });
    }
    return new McpError('INTERNAL_ERROR', 'Unexpected error', { details: error });
};
