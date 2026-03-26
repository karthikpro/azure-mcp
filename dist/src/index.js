import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AzureDevOpsClient } from './azureDevOpsClient.js';
import { loadConfig } from './config.js';
import { startHttpServer } from './http.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { CommentService, MetadataService, QueryService, WorkItemService, } from './services.js';
import { createMcpServer } from './server.js';
const main = async () => {
    const config = await loadConfig();
    const logger = createLogger(config.logLevel);
    const metrics = createMetrics();
    const azureDevOpsClient = new AzureDevOpsClient(config, logger, metrics);
    if (config.mcpTransport === 'http') {
        await startHttpServer({
            config,
            logger,
            metrics,
            azureDevOpsClient,
        });
        return;
    }
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
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('stdio MCP server started');
    const shutdown = async () => {
        logger.info('stdio MCP server shutting down');
        await server.close();
    };
    process.once('SIGINT', () => {
        void shutdown().finally(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
        void shutdown().finally(() => process.exit(0));
    });
};
void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
