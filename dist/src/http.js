import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CommentService, MetadataService, QueryService, WorkItemService, } from './services.js';
import { createMcpServer } from './server.js';
const authorizeRequest = (config) => (request, response, next) => {
    if (!config.mcpAuthToken) {
        next();
        return;
    }
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (token !== config.mcpAuthToken) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
    }
    next();
};
export const startHttpServer = async ({ config, logger, metrics, azureDevOpsClient, }) => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.get('/health', (_request, response) => {
        response.status(200).json({ status: 'ok' });
    });
    app.get('/ready', async (_request, response) => {
        const ready = await azureDevOpsClient.checkReady({ traceId: randomUUID() });
        response.status(ready ? 200 : 503).json({ ready });
    });
    app.get('/metrics', async (_request, response) => {
        response.setHeader('Content-Type', metrics.registry.contentType);
        response.send(await metrics.registry.metrics());
    });
    app.all('/mcp', authorizeRequest(config), async (request, response) => {
        const transport = new StreamableHTTPServerTransport();
        const workItemService = new WorkItemService(azureDevOpsClient, config);
        const queryService = new QueryService(azureDevOpsClient, config, workItemService);
        const commentService = new CommentService(azureDevOpsClient, config);
        const metadataService = new MetadataService(azureDevOpsClient, config);
        const server = createMcpServer({
            config,
            logger,
            metrics,
            workItemService,
            queryService,
            commentService,
            metadataService,
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(request, response, request.body);
        }
        finally {
            await server.close();
        }
    });
    const tlsConfig = await azureDevOpsClient.downloadTlsConfig();
    const nodeServer = tlsConfig
        ? createHttpsServer(tlsConfig, app)
        : createHttpServer(app);
    await new Promise((resolve) => {
        nodeServer.listen(config.mcpHttpPort, config.mcpHttpHost, () => resolve());
    });
    logger.info({
        host: config.mcpHttpHost,
        port: config.mcpHttpPort,
    }, 'HTTP MCP server started');
    const shutdown = async () => {
        logger.info('HTTP MCP server shutting down');
        await new Promise((resolve, reject) => {
            nodeServer.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    };
    process.once('SIGINT', () => {
        void shutdown().finally(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
        void shutdown().finally(() => process.exit(0));
    });
};
