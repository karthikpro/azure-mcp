import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { McpError, asMcpError } from './errors.js';
import { ErrorCode, ResourceUriParts, ToolResultPayload } from './types.js';

type CompactObject<T extends Record<string, unknown>> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

const dangerousWiqlPattern =
  /\b(delete|drop|truncate|insert|update|alter|create|merge|exec(?:ute)?|grant|revoke)\b|;|--|\/\*/i;

export const defaultFieldRefs = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.AssignedTo',
  'System.AreaPath',
  'System.IterationPath',
  'System.Description',
  'System.Tags',
  'System.CreatedDate',
  'System.ChangedDate',
  'System.Rev',
  'Microsoft.VSTS.Common.Priority',
] as const;

export const wait = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const stripHtml = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
};

export const parseTags = (value: unknown): string[] => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  return value
    .split(';')
    .map((tag) => tag.trim())
    .filter(Boolean);
};

export const quoteWiql = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export const validateWiql = (query: string): string => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new McpError('VALIDATION_ERROR', 'WIQL query must not be empty.');
  }

  if (dangerousWiqlPattern.test(trimmed)) {
    throw new McpError(
      'VALIDATION_ERROR',
      'WIQL query contains blocked tokens or comment syntax.',
    );
  }

  if (!/\bselect\b/i.test(trimmed) || !/\bfrom\s+workitems\b/i.test(trimmed)) {
    throw new McpError(
      'VALIDATION_ERROR',
      'WIQL query must target WorkItems and include a SELECT clause.',
    );
  }

  return trimmed;
};

export const successResult = (payload: ToolResultPayload): CallToolResult => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(payload, null, 2),
    },
  ],
  structuredContent: payload,
});

export const errorResult = (error: unknown): CallToolResult => {
  const normalized = asMcpError(error);
  return {
    content: [
      {
        type: 'text',
        text: `ERROR: [${normalized.code}] ${normalized.message}\nDetails: ${JSON.stringify(
          normalized.details ?? {},
          null,
          2,
        )}`,
      },
    ],
    isError: true,
  };
};

export const statusToErrorCode = (status: number): ErrorCode => {
  if (status === 401) {
    return 'UNAUTHORIZED';
  }

  if (status === 403) {
    return 'FORBIDDEN';
  }

  if (status === 404) {
    return 'NOT_FOUND';
  }

  if (status === 409 || status === 412) {
    return 'CONFLICT';
  }

  if (status === 429) {
    return 'RATE_LIMITED';
  }

  if (status >= 400 && status < 500) {
    return 'VALIDATION_ERROR';
  }

  return 'AZURE_DEVOPS_ERROR';
};

export const buildOrganizationUrl = (
  configuredOrgUrl: string,
  organization?: string,
): string => {
  if (!organization) {
    return configuredOrgUrl;
  }

  if (/^https?:\/\//i.test(organization)) {
    return organization.replace(/\/+$/, '');
  }

  return `https://dev.azure.com/${organization}`;
};

export const parseWorkItemIdFromUrl = (url: string): number | undefined => {
  const match = /workItems\/(\d+)/i.exec(url);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
};

export const buildWorkItemResourceUri = (
  organization: string,
  project: string,
  id: number,
): string => `azure-devops://${organization}/${project}/workitems/${id}`;

export const parseResourceUri = (uri: string): ResourceUriParts => {
  const parsed = new URL(uri);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.protocol !== 'azure-devops:' || parts.length !== 3 || parts[1] !== 'workitems') {
    throw new McpError('VALIDATION_ERROR', 'Unsupported resource URI.');
  }

  const id = Number(parts[2]);
  if (!Number.isInteger(id)) {
    throw new McpError('VALIDATION_ERROR', 'Resource URI work item ID is invalid.');
  }

  const project = parts[0];
  if (!project) {
    throw new McpError('VALIDATION_ERROR', 'Resource URI project is invalid.');
  }

  return {
    organization: parsed.hostname,
    project,
    id,
  };
};

export const compactObject = <T extends Record<string, unknown>>(
  value: T,
): CompactObject<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as CompactObject<T>;

export const toJsonPatch = (
  fields: Record<string, unknown>,
  rev?: number,
): Array<Record<string, unknown>> => {
  const operations: Array<Record<string, unknown>> = [];

  if (typeof rev === 'number') {
    operations.push({
      op: 'test',
      path: '/rev',
      value: rev,
    });
  }

  for (const [field, value] of Object.entries(fields)) {
    operations.push({
      op: 'add',
      path: `/fields/${field}`,
      value,
    });
  }

  return operations;
};
