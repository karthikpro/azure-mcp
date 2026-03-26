import { AzureDevOpsClient } from './azureDevOpsClient.js';
import { AppConfig } from './config.js';
import { McpError } from './errors.js';
import {
  BulkUpdateItemInput,
  ClassificationNode,
  CreateWorkItemInput,
  ProjectSummary,
  QueryResult,
  RelationMutationInput,
  RequestContext,
  UpdateWorkItemInput,
  WorkItemComment,
  WorkItemListFilters,
  WorkItemRelation,
  WorkItemSummary,
  WorkItemTypeDetails,
} from './types.js';
import {
  buildWorkItemResourceUri,
  compactObject,
  parseTags,
  parseWorkItemIdFromUrl,
  quoteWiql,
  stripHtml,
  toJsonPatch,
  validateWiql,
} from './utils.js';

const relationTypeMap: Record<string, string> = {
  child: 'System.LinkTypes.Hierarchy-Forward',
  parent: 'System.LinkTypes.Hierarchy-Reverse',
  related: 'System.LinkTypes.Related',
  predecessor: 'System.LinkTypes.Dependency-Reverse',
  successor: 'System.LinkTypes.Dependency-Forward',
  duplicate: 'System.LinkTypes.Duplicate-Forward',
};

interface AzureIdentityValue {
  displayName?: string;
  uniqueName?: string;
}

interface AzureWorkItem {
  id?: number;
  rev?: number;
  url?: string;
  fields?: Record<string, unknown>;
  relations?: Array<{
    rel?: string;
    url?: string;
    attributes?: Record<string, unknown>;
  }>;
}

const mapAssignedTo = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    const identity = value as AzureIdentityValue;
    return identity.displayName ?? identity.uniqueName ?? null;
  }

  return null;
};

const mapClassificationNode = (node: unknown): ClassificationNode => {
  const value = (node ?? {}) as Record<string, unknown>;
  return compactObject({
    id: typeof value.id === 'number' ? value.id : undefined,
    name: typeof value.name === 'string' ? value.name : 'unknown',
    path: typeof value.path === 'string' ? value.path : undefined,
    structureType:
      typeof value.structureType === 'string' ? value.structureType : undefined,
    children: Array.isArray(value.children)
      ? value.children.map((child) => mapClassificationNode(child))
      : undefined,
  });
};

export const mapWorkItem = (
  workItem: unknown,
  _organization: string,
  _project: string,
): WorkItemSummary => {
  const item = (workItem ?? {}) as AzureWorkItem;
  const fields = item.fields ?? {};

  return compactObject({
    id: item.id ?? 0,
    rev: item.rev,
    url: item.url,
    title: typeof fields['System.Title'] === 'string' ? (fields['System.Title'] as string) : null,
    type:
      typeof fields['System.WorkItemType'] === 'string'
        ? (fields['System.WorkItemType'] as string)
        : null,
    state:
      typeof fields['System.State'] === 'string' ? (fields['System.State'] as string) : null,
    assignedTo: mapAssignedTo(fields['System.AssignedTo']),
    areaPath:
      typeof fields['System.AreaPath'] === 'string'
        ? (fields['System.AreaPath'] as string)
        : null,
    iterationPath:
      typeof fields['System.IterationPath'] === 'string'
        ? (fields['System.IterationPath'] as string)
        : null,
    priority:
      typeof fields['Microsoft.VSTS.Common.Priority'] === 'number'
        ? (fields['Microsoft.VSTS.Common.Priority'] as number)
        : null,
    tags: parseTags(fields['System.Tags']),
    description: stripHtml(
      typeof fields['System.Description'] === 'string'
        ? (fields['System.Description'] as string)
        : null,
    ),
    createdDate:
      typeof fields['System.CreatedDate'] === 'string'
        ? (fields['System.CreatedDate'] as string)
        : null,
    changedDate:
      typeof fields['System.ChangedDate'] === 'string'
        ? (fields['System.ChangedDate'] as string)
        : null,
    fields,
  });
};

const normalizeProject = (project: string | undefined, config: AppConfig): string => {
  const resolved = project ?? config.azureDevopsDefaultProject;
  if (!resolved) {
    throw new McpError(
      'VALIDATION_ERROR',
      'Project is required when AZURE_DEVOPS_DEFAULT_PROJECT is not configured.',
    );
  }

  return resolved;
};

export class WorkItemService {
  public constructor(
    private readonly client: AzureDevOpsClient,
    private readonly config: AppConfig,
  ) {}

  public async getWorkItem(
    context: RequestContext,
    args: { organization?: string; project?: string; id: number; fields?: string[] },
  ): Promise<WorkItemSummary> {
    const project = normalizeProject(args.project, this.config);
    const result = await this.client.getWorkItem(context, compactObject({
      organization: args.organization,
      id: args.id,
      fields: args.fields,
      expandRelations: true,
    }));

    return mapWorkItem(result, args.organization ?? this.config.azureDevopsOrgUrl, project);
  }

  public async getWorkItems(
    context: RequestContext,
    args: { organization?: string; project?: string; ids: number[]; fields?: string[] },
  ): Promise<WorkItemSummary[]> {
    if (args.ids.length > 200) {
      throw new McpError('VALIDATION_ERROR', 'A maximum of 200 work item IDs is allowed.');
    }

    const project = normalizeProject(args.project, this.config);
    const result = await this.client.getWorkItems(context, compactObject({
      organization: args.organization,
      ids: args.ids,
      fields: args.fields,
    }));

    return result.map((item) =>
      mapWorkItem(item, args.organization ?? this.config.azureDevopsOrgUrl, project),
    );
  }

  public async createWorkItem(
    context: RequestContext,
    input: CreateWorkItemInput,
  ): Promise<WorkItemSummary> {
    const project = normalizeProject(input.project, this.config);
    const customFields = input.fields ?? {};
    await this.client.ensureFieldsExist(context, input.organization, Object.keys(customFields));

    const payload: Record<string, unknown> = {
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

  public async updateWorkItem(
    context: RequestContext,
    input: UpdateWorkItemInput,
  ): Promise<WorkItemSummary> {
    const project = normalizeProject(input.project, this.config);
    const customFields = input.fields ?? {};
    await this.client.ensureFieldsExist(context, input.organization, Object.keys(customFields));

    const payload: Record<string, unknown> = {
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

  public async bulkUpdateWorkItems(
    context: RequestContext,
    input: { organization?: string; project?: string; updates: BulkUpdateItemInput[] },
  ): Promise<{ results: Array<Record<string, unknown>> }> {
    if (input.updates.length > 200) {
      throw new McpError('VALIDATION_ERROR', 'A maximum of 200 work items is allowed.');
    }

    const results = await Promise.all(
      input.updates.map(async (update) => {
        try {
          const item = await this.updateWorkItem(
            context,
            compactObject({
              ...update,
              organization: update.organization ?? input.organization,
              project: update.project ?? input.project,
            }),
          );

          return {
            id: update.id,
            success: true,
            item,
          };
        } catch (error) {
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
      }),
    );

    return { results };
  }

  public async deleteWorkItem(
    context: RequestContext,
    input: { organization?: string; project?: string; id: number; destroy?: boolean },
  ): Promise<unknown> {
    const project = normalizeProject(input.project, this.config);
    return this.client.deleteWorkItem(context, compactObject({
      organization: input.organization,
      project,
      id: input.id,
      destroy: input.destroy,
    }));
  }

  public async getRelations(
    context: RequestContext,
    args: { organization?: string; project?: string; id: number },
  ): Promise<WorkItemRelation[]> {
    normalizeProject(args.project, this.config);
    const item = (await this.client.getWorkItem(context, compactObject({
      organization: args.organization,
      id: args.id,
      expandRelations: true,
    }))) as AzureWorkItem;

    return (item.relations ?? []).map((relation) =>
      compactObject({
        relationType: relation.rel ?? 'unknown',
        url: relation.url ?? '',
        attributes: relation.attributes,
        targetId: relation.url ? parseWorkItemIdFromUrl(relation.url) : undefined,
      }),
    );
  }

  public async addRelation(
    context: RequestContext,
    input: RelationMutationInput,
  ): Promise<WorkItemSummary> {
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

  public async removeRelation(
    context: RequestContext,
    input: RelationMutationInput,
  ): Promise<WorkItemSummary> {
    const project = normalizeProject(input.project, this.config);
    const item = (await this.client.getWorkItem(context, compactObject({
      organization: input.organization,
      id: input.sourceId,
      expandRelations: true,
    }))) as AzureWorkItem;

    const relationType = relationTypeMap[input.relationType.toLowerCase()] ?? input.relationType;
    const relationIndex = (item.relations ?? []).findIndex(
      (relation) =>
        relation.rel === relationType &&
        parseWorkItemIdFromUrl(relation.url ?? '') === input.targetId,
    );

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
  public constructor(
    private readonly client: AzureDevOpsClient,
    private readonly config: AppConfig,
    private readonly workItemService: WorkItemService,
  ) {}

  public buildStructuredWiql(filters: WorkItemListFilters): string {
    const clauses = ['[System.TeamProject] = @project'];

    if (filters.type) {
      clauses.push(`[System.WorkItemType] = ${quoteWiql(filters.type)}`);
    }
    if (filters.state) {
      clauses.push(`[System.State] = ${quoteWiql(filters.state)}`);
    }
    if (filters.assignedTo) {
      clauses.push(
        `[System.AssignedTo] = ${
          filters.assignedTo === '@me' ? '@Me' : quoteWiql(filters.assignedTo)
        }`,
      );
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

    return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(
      ' AND ',
    )} ORDER BY [System.ChangedDate] DESC`;
  }

  public async queryWorkItems(
    context: RequestContext,
    input: { organization?: string; project?: string; query: string },
  ): Promise<QueryResult> {
    const project = normalizeProject(input.project, this.config);
    validateWiql(input.query);

    const queryResponse = (await this.client.queryByWiql(context, compactObject({
      organization: input.organization,
      project,
      query: input.query,
    }))) as Record<string, unknown>;

    const workItems = Array.isArray(queryResponse.workItems)
      ? (queryResponse.workItems as Array<Record<string, unknown>>)
      : [];
    const ids = workItems
      .map((item) => item.id)
      .filter((id): id is number => typeof id === 'number');

    const items =
      ids.length > 0
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

  public async listWorkItems(
    context: RequestContext,
    filters: WorkItemListFilters,
  ): Promise<QueryResult> {
    const project = normalizeProject(filters.project, this.config);
    const top = Math.min(filters.top ?? 50, 200);
    const skip = filters.skip ?? 0;
    const wiql = this.buildStructuredWiql(filters);
    const queryResponse = (await this.client.queryByWiql(context, compactObject({
      organization: filters.organization,
      project,
      query: wiql,
    }))) as Record<string, unknown>;

    const ids = Array.isArray(queryResponse.workItems)
      ? queryResponse.workItems
          .map((item) => (item as Record<string, unknown>).id)
          .filter((id): id is number => typeof id === 'number')
      : [];

    const pagedIds = ids.slice(skip, skip + top);
    const items =
      pagedIds.length > 0
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
  public constructor(
    private readonly client: AzureDevOpsClient,
    private readonly config: AppConfig,
  ) {}

  public async getComments(
    context: RequestContext,
    input: { organization?: string; project?: string; id: number },
  ): Promise<WorkItemComment[]> {
    normalizeProject(input.project, this.config);
    const comments = await this.client.getComments(context, compactObject(input));

    return comments.map((comment) => {
      const value = (comment ?? {}) as Record<string, unknown>;
      const createdBy = value.createdBy as Record<string, unknown> | undefined;
      return compactObject({
        id: typeof value.id === 'number' ? value.id : undefined,
        text: typeof value.text === 'string' ? value.text : '',
        createdDate:
          typeof value.createdDate === 'string' ? value.createdDate : undefined,
        modifiedDate:
          typeof value.modifiedDate === 'string' ? value.modifiedDate : undefined,
        createdBy:
          typeof createdBy?.displayName === 'string'
            ? (createdBy.displayName as string)
            : null,
      });
    });
  }

  public async addComment(
    context: RequestContext,
    input: { organization?: string; project?: string; id: number; text: string },
  ): Promise<WorkItemComment> {
    normalizeProject(input.project, this.config);
    const created = (await this.client.addComment(context, compactObject(input))) as Record<
      string,
      unknown
    >;
    const createdBy = created.createdBy as Record<string, unknown> | undefined;
    return compactObject({
      id: typeof created.id === 'number' ? created.id : undefined,
      text: typeof created.text === 'string' ? created.text : input.text,
      createdDate:
        typeof created.createdDate === 'string' ? created.createdDate : undefined,
      modifiedDate:
        typeof created.modifiedDate === 'string' ? created.modifiedDate : undefined,
      createdBy:
        typeof createdBy?.displayName === 'string'
          ? (createdBy.displayName as string)
          : null,
    });
  }
}

export class MetadataService {
  public constructor(
    private readonly client: AzureDevOpsClient,
    private readonly config: AppConfig,
  ) {}

  public async listProjects(
    context: RequestContext,
    organization?: string,
  ): Promise<ProjectSummary[]> {
    const projects = await this.client.listProjects(context, organization);
    return projects.map((project) => {
      const value = (project ?? {}) as Record<string, unknown>;
      return compactObject({
        id: typeof value.id === 'string' ? value.id : undefined,
        name: typeof value.name === 'string' ? value.name : 'unknown',
        description:
          typeof value.description === 'string' ? value.description : undefined,
        state: typeof value.state === 'string' ? value.state : undefined,
        visibility:
          typeof value.visibility === 'string' ? value.visibility : undefined,
        url: typeof value.url === 'string' ? value.url : undefined,
      });
    });
  }

  public async listWorkItemTypes(
    context: RequestContext,
    input: { organization?: string; project?: string },
  ): Promise<WorkItemTypeDetails[]> {
    const project = normalizeProject(input.project, this.config);
    const types = await this.client.listWorkItemTypes(context, compactObject({
      organization: input.organization,
      project,
    }));

    return Promise.all(
      types.map(async (typeItem) => {
        const value = (typeItem ?? {}) as Record<string, unknown>;
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

        const iconValue =
          typeof value.icon === 'object' && value.icon !== null
            ? (value.icon as { url?: unknown }).url
            : undefined;

        return compactObject({
          name: typeName,
          description:
            typeof value.description === 'string' ? value.description : null,
          color: typeof value.color === 'string' ? value.color : null,
          icon: typeof iconValue === 'string' ? iconValue : null,
          isDisabled:
            typeof value.isDisabled === 'boolean' ? value.isDisabled : undefined,
          states: states as Array<Record<string, unknown>>,
          fields: fields as Array<Record<string, unknown>>,
        });
      }),
    );
  }

  public async listIterations(
    context: RequestContext,
    input: { organization?: string; project?: string },
  ): Promise<ClassificationNode> {
    const project = normalizeProject(input.project, this.config);
    const result = await this.client.listClassificationNodes(context, {
      ...(input.organization ? { organization: input.organization } : {}),
      project,
      structureGroup: 'iterations',
    });

    return mapClassificationNode(result);
  }

  public async listAreaPaths(
    context: RequestContext,
    input: { organization?: string; project?: string },
  ): Promise<ClassificationNode> {
    const project = normalizeProject(input.project, this.config);
    const result = await this.client.listClassificationNodes(context, {
      ...(input.organization ? { organization: input.organization } : {}),
      project,
      structureGroup: 'areas',
    });

    return mapClassificationNode(result);
  }

  public createResourcePayload(
    organization: string,
    project: string,
    item: WorkItemSummary,
  ): Record<string, unknown> {
    return {
      uri: buildWorkItemResourceUri(organization, project, item.id),
      mimeType: 'application/json',
      workItem: item,
    };
  }
}
