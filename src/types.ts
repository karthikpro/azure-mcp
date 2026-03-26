export type ErrorCode =
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'AZURE_DEVOPS_ERROR'
  | 'INTERNAL_ERROR';

export interface WorkItemSummary {
  id: number;
  rev?: number;
  url?: string;
  title: string | null;
  type: string | null;
  state: string | null;
  assignedTo: string | null;
  areaPath: string | null;
  iterationPath: string | null;
  priority: number | null;
  tags: string[];
  description: string | null;
  createdDate: string | null;
  changedDate: string | null;
  fields: Record<string, unknown>;
}

export interface QueryResult {
  items: WorkItemSummary[];
  ids: number[];
  totalCount: number;
  hasMore: boolean;
}

export interface WorkItemRelation {
  relationType: string;
  url: string;
  attributes?: Record<string, unknown>;
  targetId?: number;
}

export interface WorkItemComment {
  id?: number;
  text: string;
  createdDate?: string;
  modifiedDate?: string;
  createdBy?: string | null;
}

export interface WorkItemTypeDetails {
  name: string;
  description: string | null;
  color?: string | null;
  icon?: string | null;
  isDisabled?: boolean;
  states: Array<Record<string, unknown>>;
  fields: Array<Record<string, unknown>>;
}

export interface ProjectSummary {
  id?: string;
  name: string;
  description?: string | null;
  state?: string | null;
  visibility?: string | null;
  url?: string;
}

export interface ClassificationNode {
  id?: number;
  name: string;
  path?: string;
  structureType?: string;
  children?: ClassificationNode[];
}

export interface RequestContext {
  traceId: string;
  toolName?: string;
}

export interface ToolResultPayload {
  [key: string]: unknown;
}

export interface WorkItemListFilters {
  organization?: string;
  project?: string;
  type?: string;
  state?: string;
  assignedTo?: string;
  iteration?: string;
  areaPath?: string;
  tags?: string[];
  createdAfter?: string;
  changedAfter?: string;
  top?: number;
  skip?: number;
}

export interface CreateWorkItemInput {
  organization?: string;
  project?: string;
  type: string;
  title: string;
  description?: string;
  assignedTo?: string;
  areaPath?: string;
  iterationPath?: string;
  priority?: number;
  tags?: string[];
  parent?: number;
  fields?: Record<string, unknown>;
}

export interface UpdateWorkItemInput {
  organization?: string;
  project?: string;
  id: number;
  rev?: number;
  title?: string;
  description?: string;
  state?: string;
  assignedTo?: string;
  areaPath?: string;
  iterationPath?: string;
  priority?: number;
  tags?: string[];
  fields?: Record<string, unknown>;
}

export type BulkUpdateItemInput = UpdateWorkItemInput;

export interface DeleteWorkItemInput {
  organization?: string;
  project?: string;
  id: number;
  destroy?: boolean;
  confirm: boolean;
}

export interface RelationMutationInput {
  organization?: string;
  project?: string;
  sourceId: number;
  targetId: number;
  relationType: string;
}

export interface ResourceUriParts {
  organization: string;
  project: string;
  id: number;
}
