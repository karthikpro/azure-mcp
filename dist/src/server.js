import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { compactObject, errorResult, successResult } from './utils.js';
const observeTool = async (toolName, args, logger, metrics, handler) => {
    const traceId = randomUUID();
    const startedAt = Date.now();
    const childLogger = logger.child({ traceId, toolName });
    try {
        const payload = await handler(args, { traceId, toolName });
        const durationSeconds = (Date.now() - startedAt) / 1000;
        metrics.mcpToolCallsTotal.inc({ tool: toolName, status: 'success' });
        metrics.mcpToolDurationSeconds.observe({ tool: toolName }, durationSeconds);
        childLogger.info({ durationMs: Date.now() - startedAt }, 'Tool completed');
        return successResult(payload);
    }
    catch (error) {
        const durationSeconds = (Date.now() - startedAt) / 1000;
        metrics.mcpToolCallsTotal.inc({ tool: toolName, status: 'error' });
        metrics.mcpToolDurationSeconds.observe({ tool: toolName }, durationSeconds);
        childLogger.error({ err: error, durationMs: Date.now() - startedAt }, 'Tool failed');
        return errorResult(error);
    }
};
export const createMcpServer = ({ config, logger, metrics, workItemService, queryService, commentService, metadataService, }) => {
    const server = new McpServer({
        name: 'azure-devops-mcp',
        version: '0.1.0',
    });
    server.registerTool('get_work_item', {
        title: 'Get Work Item',
        description: 'Retrieve a single Azure DevOps work item by ID.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            id: z.number().int().positive(),
            fields: z.array(z.string()).min(1).max(100).optional(),
        },
    }, async (args) => observeTool('get_work_item', args, logger, metrics, async (input, context) => ({
        workItem: await workItemService.getWorkItem(context, compactObject(input)),
    })));
    server.registerTool('get_work_items', {
        title: 'Get Work Items',
        description: 'Retrieve up to 200 Azure DevOps work items by ID.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            ids: z.array(z.number().int().positive()).min(1).max(200),
            fields: z.array(z.string()).min(1).max(100).optional(),
        },
    }, async (args) => observeTool('get_work_items', args, logger, metrics, async (input, context) => ({
        items: await workItemService.getWorkItems(context, compactObject(input)),
    })));
    server.registerTool('query_work_items', {
        title: 'Query Work Items',
        description: 'Execute a WIQL query against Azure DevOps work items.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            query: z.string().min(1),
        },
    }, async (args) => observeTool('query_work_items', args, logger, metrics, async (input, context) => {
        const result = await queryService.queryWorkItems(context, compactObject(input));
        return {
            ...result,
        };
    }));
    server.registerTool('list_work_items', {
        title: 'List Work Items',
        description: 'List work items with structured filters without writing WIQL.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            type: z.string().optional(),
            state: z.string().optional(),
            assignedTo: z.string().optional(),
            iteration: z.string().optional(),
            areaPath: z.string().optional(),
            tags: z.array(z.string()).optional(),
            createdAfter: z.string().datetime().optional(),
            changedAfter: z.string().datetime().optional(),
            top: z.number().int().positive().max(200).default(50),
            skip: z.number().int().min(0).default(0),
        },
    }, async (args) => observeTool('list_work_items', args, logger, metrics, async (input, context) => {
        const result = await queryService.listWorkItems(context, compactObject(input));
        return {
            ...result,
        };
    }));
    server.registerTool('create_work_item', {
        title: 'Create Work Item',
        description: 'Create a new Azure DevOps work item.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            type: z.string().min(1),
            title: z.string().min(1).max(255),
            description: z.string().optional(),
            assignedTo: z.string().optional(),
            areaPath: z.string().optional(),
            iterationPath: z.string().optional(),
            priority: z.number().int().min(1).max(4).optional(),
            tags: z.array(z.string()).optional(),
            parent: z.number().int().positive().optional(),
            fields: z.record(z.string(), z.unknown()).optional(),
        },
    }, async (args) => observeTool('create_work_item', args, logger, metrics, async (input, context) => ({
        workItem: await workItemService.createWorkItem(context, compactObject(input)),
    })));
    server.registerTool('update_work_item', {
        title: 'Update Work Item',
        description: 'Update an existing Azure DevOps work item.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            id: z.number().int().positive(),
            rev: z.number().int().positive().optional(),
            title: z.string().optional(),
            description: z.string().optional(),
            state: z.string().optional(),
            assignedTo: z.string().optional(),
            areaPath: z.string().optional(),
            iterationPath: z.string().optional(),
            priority: z.number().int().min(1).max(4).optional(),
            tags: z.array(z.string()).optional(),
            fields: z.record(z.string(), z.unknown()).optional(),
        },
    }, async (args) => observeTool('update_work_item', args, logger, metrics, async (input, context) => ({
        workItem: await workItemService.updateWorkItem(context, compactObject(input)),
    })));
    server.registerTool('bulk_update_work_items', {
        title: 'Bulk Update Work Items',
        description: 'Update up to 200 Azure DevOps work items and return per-item results.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            updates: z
                .array(z.object({
                organization: z.string().optional(),
                project: z.string().optional(),
                id: z.number().int().positive(),
                rev: z.number().int().positive().optional(),
                title: z.string().optional(),
                description: z.string().optional(),
                state: z.string().optional(),
                assignedTo: z.string().optional(),
                areaPath: z.string().optional(),
                iterationPath: z.string().optional(),
                priority: z.number().int().min(1).max(4).optional(),
                tags: z.array(z.string()).optional(),
                fields: z.record(z.string(), z.unknown()).optional(),
            }))
                .min(1)
                .max(200),
        },
    }, async (args) => observeTool('bulk_update_work_items', args, logger, metrics, async (input, context) => workItemService.bulkUpdateWorkItems(context, {
        ...(input.organization ? { organization: input.organization } : {}),
        ...(input.project ? { project: input.project } : {}),
        updates: input.updates.map((update) => compactObject(update)),
    })));
    server.registerTool('delete_work_item', {
        title: 'Delete Work Item',
        description: 'Delete a work item or move it to the recycle bin.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            id: z.number().int().positive(),
            destroy: z.boolean().default(false),
            confirm: z.boolean(),
        },
    }, async (args) => observeTool('delete_work_item', args, logger, metrics, async (input, context) => {
        if (!input.confirm) {
            throw new Error('Delete requires confirm: true.');
        }
        return {
            result: await workItemService.deleteWorkItem(context, compactObject({
                organization: input.organization,
                project: input.project,
                id: input.id,
                destroy: input.destroy,
            })),
        };
    }));
    server.registerTool('get_comments', {
        title: 'Get Comments',
        description: 'Retrieve comments for a work item.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            id: z.number().int().positive(),
        },
    }, async (args) => observeTool('get_comments', args, logger, metrics, async (input, context) => ({
        comments: await commentService.getComments(context, compactObject(input)),
    })));
    server.registerTool('add_comment', {
        title: 'Add Comment',
        description: 'Add a Markdown comment to a work item.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            id: z.number().int().positive(),
            text: z.string().min(1),
        },
    }, async (args) => observeTool('add_comment', args, logger, metrics, async (input, context) => ({
        comment: await commentService.addComment(context, compactObject(input)),
    })));
    server.registerTool('get_relations', {
        title: 'Get Relations',
        description: 'Retrieve work item links and relations.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            id: z.number().int().positive(),
        },
    }, async (args) => observeTool('get_relations', args, logger, metrics, async (input, context) => ({
        relations: await workItemService.getRelations(context, compactObject(input)),
    })));
    server.registerTool('add_relation', {
        title: 'Add Relation',
        description: 'Add a relation between two work items.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            sourceId: z.number().int().positive(),
            targetId: z.number().int().positive(),
            relationType: z.string().min(1),
        },
    }, async (args) => observeTool('add_relation', args, logger, metrics, async (input, context) => ({
        workItem: await workItemService.addRelation(context, compactObject(input)),
    })));
    server.registerTool('remove_relation', {
        title: 'Remove Relation',
        description: 'Remove a relation between two work items.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
            sourceId: z.number().int().positive(),
            targetId: z.number().int().positive(),
            relationType: z.string().min(1),
        },
    }, async (args) => observeTool('remove_relation', args, logger, metrics, async (input, context) => ({
        workItem: await workItemService.removeRelation(context, compactObject(input)),
    })));
    server.registerTool('list_projects', {
        title: 'List Projects',
        description: 'List Azure DevOps projects accessible to the configured credential.',
        inputSchema: {
            organization: z.string().optional(),
        },
    }, async (args) => observeTool('list_projects', args, logger, metrics, async (input, context) => ({
        projects: await metadataService.listProjects(context, input.organization),
    })));
    server.registerTool('list_work_item_types', {
        title: 'List Work Item Types',
        description: 'List work item types for a project including states and fields.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
        },
    }, async (args) => observeTool('list_work_item_types', args, logger, metrics, async (input, context) => ({
        types: await metadataService.listWorkItemTypes(context, compactObject(input)),
    })));
    server.registerTool('list_iterations', {
        title: 'List Iterations',
        description: 'List iteration paths for a project.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
        },
    }, async (args) => observeTool('list_iterations', args, logger, metrics, async (input, context) => ({
        iterations: await metadataService.listIterations(context, compactObject(input)),
    })));
    server.registerTool('list_area_paths', {
        title: 'List Area Paths',
        description: 'List area paths for a project.',
        inputSchema: {
            organization: z.string().optional(),
            project: z.string().optional(),
        },
    }, async (args) => observeTool('list_area_paths', args, logger, metrics, async (input, context) => ({
        areaPaths: await metadataService.listAreaPaths(context, compactObject(input)),
    })));
    server.registerPrompt('summarize_sprint', {
        title: 'Summarize Sprint',
        description: 'Create a prompt that summarizes sprint progress from Azure DevOps work items.',
        argsSchema: {
            project: z.string(),
            iterationPath: z.string(),
        },
    }, async ({ project, iterationPath }) => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `Summarize sprint progress for project "${project}" and iteration "${iterationPath}". Highlight completed work, blocked work, risks, and suggested follow-ups.`,
                },
            },
        ],
    }));
    server.registerPrompt('triage_bugs', {
        title: 'Triage Bugs',
        description: 'Create a prompt for bug triage based on Azure DevOps backlog data.',
        argsSchema: {
            project: z.string(),
            areaPath: z.string().optional(),
        },
    }, async ({ project, areaPath }) => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `Triage bugs for project "${project}"${areaPath ? ` in area "${areaPath}"` : ''}. Group issues by severity, likely owner, and next action.`,
                },
            },
        ],
    }));
    server.registerPrompt('draft_work_item', {
        title: 'Draft Work Item',
        description: 'Create a prompt that drafts a new Azure DevOps work item.',
        argsSchema: {
            project: z.string(),
            type: z.string(),
            goal: z.string(),
        },
    }, async ({ project, type, goal }) => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `Draft an Azure DevOps ${type} for project "${project}" based on this goal: ${goal}. Include a concise title, description, acceptance criteria, and suggested tags.`,
                },
            },
        ],
    }));
    server.registerResource('azure-devops-server-info', 'azure-devops://server/info', {
        title: 'Azure DevOps MCP Server Info',
        description: 'Metadata about the Azure DevOps MCP server configuration.',
        mimeType: 'application/json',
    }, async (uri) => ({
        contents: [
            {
                uri: uri.toString(),
                mimeType: 'application/json',
                text: JSON.stringify({
                    organizationUrl: config.azureDevopsOrgUrl,
                    defaultProject: config.azureDevopsDefaultProject ?? null,
                    transport: config.mcpTransport,
                }, null, 2),
            },
        ],
    }));
    const workItemTemplate = new ResourceTemplate('azure-devops://{organization}/{project}/workitems/{id}', {
        list: async () => ({
            resources: [],
        }),
    });
    server.registerResource('azure-devops-work-item', workItemTemplate, {
        title: 'Azure DevOps Work Item',
        description: 'Read a work item as an MCP resource.',
        mimeType: 'application/json',
    }, async (uri, variables) => {
        const organization = typeof variables.organization === 'string' ? variables.organization : undefined;
        const project = typeof variables.project === 'string' ? variables.project : undefined;
        const id = Number(variables.id);
        const traceId = randomUUID();
        const item = await workItemService.getWorkItem({ traceId, toolName: 'resource:azure-devops-work-item' }, compactObject({ organization, project, id }));
        return {
            contents: [
                {
                    uri: uri.toString(),
                    mimeType: 'application/json',
                    text: JSON.stringify(item, null, 2),
                },
            ],
        };
    });
    return server;
};
