import { McpError } from './errors.js';
import { buildWorkItemResourceUri, compactObject, parseTags, parseWorkItemIdFromUrl, quoteWiql, stripHtml, toJsonPatch, validateWiql, } from './utils.js';
const relationTypeMap = {
    child: 'System.LinkTypes.Hierarchy-Forward',
    parent: 'System.LinkTypes.Hierarchy-Reverse',
    related: 'System.LinkTypes.Related',
    predecessor: 'System.LinkTypes.Dependency-Reverse',
    successor: 'System.LinkTypes.Dependency-Forward',
    duplicate: 'System.LinkTypes.Duplicate-Forward',
};
const mapAssignedTo = (value) => {
    if (!value) {
        return null;
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'object') {
        const identity = value;
        return identity.displayName ?? identity.uniqueName ?? null;
    }
    return null;
};
const mapClassificationNode = (node) => {
    const value = (node ?? {});
    return compactObject({
        id: typeof value.id === 'number' ? value.id : undefined,
        name: typeof value.name === 'string' ? value.name : 'unknown',
        path: typeof value.path === 'string' ? value.path : undefined,
        structureType: typeof value.structureType === 'string' ? value.structureType : undefined,
        children: Array.isArray(value.children)
            ? value.children.map((child) => mapClassificationNode(child))
            : undefined,
    });
};
export const mapWorkItem = (workItem, _organization, _project) => {
    const item = (workItem ?? {});
    const fields = item.fields ?? {};
    return compactObject({
        id: item.id ?? 0,
        rev: item.rev,
        url: item.url,
        title: typeof fields['System.Title'] === 'string' ? fields['System.Title'] : null,
        type: typeof fields['System.WorkItemType'] === 'string'
            ? fields['System.WorkItemType']
            : null,
        state: typeof fields['System.State'] === 'string' ? fields['System.State'] : null,
        assignedTo: mapAssignedTo(fields['System.AssignedTo']),
        areaPath: typeof fields['System.AreaPath'] === 'string'
            ? fields['System.AreaPath']
            : null,
        iterationPath: typeof fields['System.IterationPath'] === 'string'
            ? fields['System.IterationPath']
            : null,
        priority: typeof fields['Microsoft.VSTS.Common.Priority'] === 'number'
            ? fields['Microsoft.VSTS.Common.Priority']
            : null,
        tags: parseTags(fields['System.Tags']),
        description: stripHtml(typeof fields['System.Description'] === 'string'
            ? fields['System.Description']
            : null),
        createdDate: typeof fields['System.CreatedDate'] === 'string'
            ? fields['System.CreatedDate']
            : null,
        changedDate: typeof fields['System.ChangedDate'] === 'string'
            ? fields['System.ChangedDate']
            : null,
        fields,
    });
};
const normalizeProject = (project, config) => {
    const resolved = project ?? config.azureDevopsDefaultProject;
    if (!resolved) {
        throw new McpError('VALIDATION_ERROR', 'Project is required when AZURE_DEVOPS_DEFAULT_PROJECT is not configured.');
    }
    return resolved;
};
export class WorkItemService {
    client;
    config;
    constructor(client, config) {
        this.client = client;
        this.config = config;
    }
    async getWorkItem(context, args) {
        const project = normalizeProject(args.project, this.config);
        const result = await this.client.getWorkItem(context, compactObject({
            organization: args.organization,
            id: args.id,
            fields: args.fields,
            expandRelations: true,
        }));
        return mapWorkItem(result, args.organization ?? this.config.azureDevopsOrgUrl, project);
    }
    async getWorkItems(context, args) {
        if (args.ids.length > 200) {
            throw new McpError('VALIDATION_ERROR', 'A maximum of 200 work item IDs is allowed.');
        }
        const project = normalizeProject(args.project, this.config);
        const result = await this.client.getWorkItems(context, compactObject({
            organization: args.organization,
            ids: args.ids,
            fields: args.fields,
        }));
        return result.map((item) => mapWorkItem(item, args.organization ?? this.config.azureDevopsOrgUrl, project));
    }
    async createWorkItem(context, input) {
        const project = normalizeProject(input.project, this.config);
        const customFields = input.fields ?? {};
        await this.client.ensureFieldsExist(context, input.organization, Object.keys(customFields));
        const payload = {
            'System.Title': input.title,
            ...customFields,
        };
        if (input.description) {
            payload['System.Description'] = input.description;
        }
        if (input.assignedTo) {
            payload['System.AssignedTo'] = input.assignedTo;
        }
        if (input.areaPath) {
            payload['System.AreaPath'] = input.areaPath;
        }
        if (input.iterationPath) {
            payload['System.IterationPath'] = input.iterationPath;
        }
        if (typeof input.priority === 'number') {
            payload['Microsoft.VSTS.Common.Priority'] = input.priority;
        }
        if (input.tags?.length) {
            payload['System.Tags'] = input.tags.join('; ');
        }
        const patchDocument = toJsonPatch(payload);
        if (typeof input.parent === 'number') {
            patchDocument.push({
                op: 'add',
                path: '/relations/-',
                value: {
                    rel: relationTypeMap.parent,
                    url: `${this.config.azureDevopsOrgUrl}/_apis/wit/workItems/${input.parent}`,
                },
            });
        }
        const created = await this.client.createWorkItem(context, compactObject({
            organization: input.organization,
            project,
            type: input.type,
            patchDocument,
        }));
        return mapWorkItem(created, input.organization ?? this.config.azureDevopsOrgUrl, project);
    }
    async updateWorkItem(context, input) {
        const project = normalizeProject(input.project, this.config);
        const customFields = input.fields ?? {};
        await this.client.ensureFieldsExist(context, input.organization, Object.keys(customFields));
        const payload = {
            ...customFields,
        };
        if (input.title) {
            payload['System.Title'] = input.title;
        }
        if (input.description) {
            payload['System.Description'] = input.description;
        }
        if (input.state) {
            payload['System.State'] = input.state;
        }
        if (input.assignedTo) {
            payload['System.AssignedTo'] = input.assignedTo;
        }
        if (input.areaPath) {
            payload['System.AreaPath'] = input.areaPath;
        }
        if (input.iterationPath) {
            payload['System.IterationPath'] = input.iterationPath;
        }
        if (typeof input.priority === 'number') {
            payload['Microsoft.VSTS.Common.Priority'] = input.priority;
        }
        if (input.tags) {
            payload['System.Tags'] = input.tags.join('; ');
        }
        if (Object.keys(payload).length === 0) {
            throw new McpError('VALIDATION_ERROR', 'At least one field must be supplied for update.');
        }
        const updated = await this.client.updateWorkItem(context, compactObject({
            organization: input.organization,
            project,
            id: input.id,
            patchDocument: toJsonPatch(payload, input.rev),
        }));
        return mapWorkItem(updated, input.organization ?? this.config.azureDevopsOrgUrl, project);
    }
    async bulkUpdateWorkItems(context, input) {
        if (input.updates.length > 200) {
            throw new McpError('VALIDATION_ERROR', 'A maximum of 200 work items is allowed.');
        }
        const results = await Promise.all(input.updates.map(async (update) => {
            try {
                const item = await this.updateWorkItem(context, compactObject({
                    ...update,
                    organization: update.organization ?? input.organization,
                    project: update.project ?? input.project,
                }));
                return {
                    id: update.id,
                    success: true,
                    item,
                };
            }
            catch (error) {
                const normalized = error instanceof McpError ? error : new McpError('INTERNAL_ERROR', 'Bulk update failed.', { details: error });
                return {
                    id: update.id,
                    success: false,
                    error: {
                        code: normalized.code,
                        message: normalized.message,
                        details: normalized.details,
                    },
                };
            }
        }));
        return { results };
    }
    async deleteWorkItem(context, input) {
        const project = normalizeProject(input.project, this.config);
        return this.client.deleteWorkItem(context, compactObject({
            organization: input.organization,
            project,
            id: input.id,
            destroy: input.destroy,
        }));
    }
    async getRelations(context, args) {
        normalizeProject(args.project, this.config);
        const item = (await this.client.getWorkItem(context, compactObject({
            organization: args.organization,
            id: args.id,
            expandRelations: true,
        })));
        return (item.relations ?? []).map((relation) => compactObject({
            relationType: relation.rel ?? 'unknown',
            url: relation.url ?? '',
            attributes: relation.attributes,
            targetId: relation.url ? parseWorkItemIdFromUrl(relation.url) : undefined,
        }));
    }
    async addRelation(context, input) {
        const project = normalizeProject(input.project, this.config);
        const relationType = relationTypeMap[input.relationType.toLowerCase()] ?? input.relationType;
        const updated = await this.client.updateWorkItem(context, compactObject({
            organization: input.organization,
            project,
            id: input.sourceId,
            patchDocument: [
                {
                    op: 'add',
                    path: '/relations/-',
                    value: {
                        rel: relationType,
                        url: `${this.config.azureDevopsOrgUrl}/_apis/wit/workItems/${input.targetId}`,
                    },
                },
            ],
        }));
        return mapWorkItem(updated, input.organization ?? this.config.azureDevopsOrgUrl, project);
    }
    async removeRelation(context, input) {
        const project = normalizeProject(input.project, this.config);
        const item = (await this.client.getWorkItem(context, compactObject({
            organization: input.organization,
            id: input.sourceId,
            expandRelations: true,
        })));
        const relationType = relationTypeMap[input.relationType.toLowerCase()] ?? input.relationType;
        const relationIndex = (item.relations ?? []).findIndex((relation) => relation.rel === relationType &&
            parseWorkItemIdFromUrl(relation.url ?? '') === input.targetId);
        if (relationIndex < 0) {
            throw new McpError('NOT_FOUND', 'Requested work item relation was not found.');
        }
        const updated = await this.client.updateWorkItem(context, compactObject({
            organization: input.organization,
            project,
            id: input.sourceId,
            patchDocument: [
                {
                    op: 'remove',
                    path: `/relations/${relationIndex}`,
                },
            ],
        }));
        return mapWorkItem(updated, input.organization ?? this.config.azureDevopsOrgUrl, project);
    }
}
export class QueryService {
    client;
    config;
    workItemService;
    constructor(client, config, workItemService) {
        this.client = client;
        this.config = config;
        this.workItemService = workItemService;
    }
    buildStructuredWiql(filters) {
        const clauses = ['[System.TeamProject] = @project'];
        if (filters.type) {
            clauses.push(`[System.WorkItemType] = ${quoteWiql(filters.type)}`);
        }
        if (filters.state) {
            clauses.push(`[System.State] = ${quoteWiql(filters.state)}`);
        }
        if (filters.assignedTo) {
            clauses.push(`[System.AssignedTo] = ${filters.assignedTo === '@me' ? '@Me' : quoteWiql(filters.assignedTo)}`);
        }
        if (filters.iteration) {
            clauses.push(`[System.IterationPath] UNDER ${quoteWiql(filters.iteration)}`);
        }
        if (filters.areaPath) {
            clauses.push(`[System.AreaPath] UNDER ${quoteWiql(filters.areaPath)}`);
        }
        if (filters.tags?.length) {
            for (const tag of filters.tags) {
                clauses.push(`[System.Tags] CONTAINS ${quoteWiql(tag)}`);
            }
        }
        if (filters.createdAfter) {
            clauses.push(`[System.CreatedDate] >= ${quoteWiql(filters.createdAfter)}`);
        }
        if (filters.changedAfter) {
            clauses.push(`[System.ChangedDate] >= ${quoteWiql(filters.changedAfter)}`);
        }
        return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
    }
    async queryWorkItems(context, input) {
        const project = normalizeProject(input.project, this.config);
        validateWiql(input.query);
        const queryResponse = (await this.client.queryByWiql(context, compactObject({
            organization: input.organization,
            project,
            query: input.query,
        })));
        const workItems = Array.isArray(queryResponse.workItems)
            ? queryResponse.workItems
            : [];
        const ids = workItems
            .map((item) => item.id)
            .filter((id) => typeof id === 'number');
        const items = ids.length > 0
            ? await this.workItemService.getWorkItems(context, compactObject({
                organization: input.organization,
                project,
                ids,
            }))
            : [];
        return {
            ids,
            items,
            totalCount: ids.length,
            hasMore: false,
        };
    }
    async listWorkItems(context, filters) {
        const project = normalizeProject(filters.project, this.config);
        const top = Math.min(filters.top ?? 50, 200);
        const skip = filters.skip ?? 0;
        const wiql = this.buildStructuredWiql(filters);
        const queryResponse = (await this.client.queryByWiql(context, compactObject({
            organization: filters.organization,
            project,
            query: wiql,
        })));
        const ids = Array.isArray(queryResponse.workItems)
            ? queryResponse.workItems
                .map((item) => item.id)
                .filter((id) => typeof id === 'number')
            : [];
        const pagedIds = ids.slice(skip, skip + top);
        const items = pagedIds.length > 0
            ? await this.workItemService.getWorkItems(context, compactObject({
                organization: filters.organization,
                project,
                ids: pagedIds,
            }))
            : [];
        return {
            ids: pagedIds,
            items,
            totalCount: ids.length,
            hasMore: skip + pagedIds.length < ids.length,
        };
    }
}
export class CommentService {
    client;
    config;
    constructor(client, config) {
        this.client = client;
        this.config = config;
    }
    async getComments(context, input) {
        normalizeProject(input.project, this.config);
        const comments = await this.client.getComments(context, compactObject(input));
        return comments.map((comment) => {
            const value = (comment ?? {});
            const createdBy = value.createdBy;
            return compactObject({
                id: typeof value.id === 'number' ? value.id : undefined,
                text: typeof value.text === 'string' ? value.text : '',
                createdDate: typeof value.createdDate === 'string' ? value.createdDate : undefined,
                modifiedDate: typeof value.modifiedDate === 'string' ? value.modifiedDate : undefined,
                createdBy: typeof createdBy?.displayName === 'string'
                    ? createdBy.displayName
                    : null,
            });
        });
    }
    async addComment(context, input) {
        normalizeProject(input.project, this.config);
        const created = (await this.client.addComment(context, compactObject(input)));
        const createdBy = created.createdBy;
        return compactObject({
            id: typeof created.id === 'number' ? created.id : undefined,
            text: typeof created.text === 'string' ? created.text : input.text,
            createdDate: typeof created.createdDate === 'string' ? created.createdDate : undefined,
            modifiedDate: typeof created.modifiedDate === 'string' ? created.modifiedDate : undefined,
            createdBy: typeof createdBy?.displayName === 'string'
                ? createdBy.displayName
                : null,
        });
    }
}
export class MetadataService {
    client;
    config;
    constructor(client, config) {
        this.client = client;
        this.config = config;
    }
    async listProjects(context, organization) {
        const projects = await this.client.listProjects(context, organization);
        return projects.map((project) => {
            const value = (project ?? {});
            return compactObject({
                id: typeof value.id === 'string' ? value.id : undefined,
                name: typeof value.name === 'string' ? value.name : 'unknown',
                description: typeof value.description === 'string' ? value.description : undefined,
                state: typeof value.state === 'string' ? value.state : undefined,
                visibility: typeof value.visibility === 'string' ? value.visibility : undefined,
                url: typeof value.url === 'string' ? value.url : undefined,
            });
        });
    }
    async listWorkItemTypes(context, input) {
        const project = normalizeProject(input.project, this.config);
        const types = await this.client.listWorkItemTypes(context, compactObject({
            organization: input.organization,
            project,
        }));
        return Promise.all(types.map(async (typeItem) => {
            const value = (typeItem ?? {});
            const typeName = typeof value.name === 'string' ? value.name : '';
            const [states, fields] = await Promise.all([
                this.client.listWorkItemTypeStates(context, compactObject({
                    organization: input.organization,
                    project,
                    type: typeName,
                })),
                this.client.listWorkItemTypeFields(context, compactObject({
                    organization: input.organization,
                    project,
                    type: typeName,
                })),
            ]);
            const iconValue = typeof value.icon === 'object' && value.icon !== null
                ? value.icon.url
                : undefined;
            return compactObject({
                name: typeName,
                description: typeof value.description === 'string' ? value.description : null,
                color: typeof value.color === 'string' ? value.color : null,
                icon: typeof iconValue === 'string' ? iconValue : null,
                isDisabled: typeof value.isDisabled === 'boolean' ? value.isDisabled : undefined,
                states: states,
                fields: fields,
            });
        }));
    }
    async listIterations(context, input) {
        const project = normalizeProject(input.project, this.config);
        const result = await this.client.listClassificationNodes(context, {
            ...(input.organization ? { organization: input.organization } : {}),
            project,
            structureGroup: 'iterations',
        });
        return mapClassificationNode(result);
    }
    async listAreaPaths(context, input) {
        const project = normalizeProject(input.project, this.config);
        const result = await this.client.listClassificationNodes(context, {
            ...(input.organization ? { organization: input.organization } : {}),
            project,
            structureGroup: 'areas',
        });
        return mapClassificationNode(result);
    }
    createResourcePayload(organization, project, item) {
        return {
            uri: buildWorkItemResourceUri(organization, project, item.id),
            mimeType: 'application/json',
            workItem: item,
        };
    }
}
