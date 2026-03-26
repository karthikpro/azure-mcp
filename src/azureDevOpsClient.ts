import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

import {
  AuthenticationRecord,
  DefaultAzureCredential,
  InteractiveBrowserCredential,
  InteractiveBrowserCredentialNodeOptions,
  deserializeAuthenticationRecord,
  serializeAuthenticationRecord,
  useIdentityPlugin,
} from '@azure/identity';
import { cachePersistencePlugin } from '@azure/identity-cache-persistence';
import CircuitBreaker from 'opossum';
import { Logger } from 'pino';

import { AppConfig } from './config.js';
import { McpError } from './errors.js';
import { Metrics } from './metrics.js';
import { RequestContext } from './types.js';
import {
  buildOrganizationUrl,
  compactObject,
  defaultFieldRefs,
  statusToErrorCode,
  validateWiql,
  wait,
} from './utils.js';

const azureDevopsScope = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const tokenCacheName = 'azure-devops-mcp';

useIdentityPlugin(cachePersistencePlugin);

interface RequestOptions {
  organization?: string;
  project?: string;
  path: string;
  apiVersion?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
  operation: string;
  context: RequestContext;
}

interface AzureDevOpsResponse {
  status: number;
  json: unknown;
}

interface AzureFieldReference {
  referenceName?: string;
}

export class AzureDevOpsClient {
  private readonly defaultCredential = new DefaultAzureCredential();
  private readonly breaker: CircuitBreaker<[RequestOptions], AzureDevOpsResponse>;
  private readonly knownFieldsCache = new Map<string, Set<string>>();
  private interactiveCredential: InteractiveBrowserCredential | undefined;
  private hasInteractiveAuthenticationRecord = false;
  private interactiveAuthenticationPromise: Promise<void> | undefined;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {
    this.breaker = new CircuitBreaker(this.performRequest.bind(this), {
      errorThresholdPercentage: 50,
      resetTimeout: 60000,
      rollingCountTimeout: 30000,
      rollingCountBuckets: 5,
      volumeThreshold: 5,
    });

    this.breaker.on('open', () => this.metrics.circuitBreakerState.set(2));
    this.breaker.on('halfOpen', () => this.metrics.circuitBreakerState.set(1));
    this.breaker.on('close', () => this.metrics.circuitBreakerState.set(0));
  }

  public async checkReady(context: RequestContext): Promise<boolean> {
    try {
      await this.request({
        path: '/_apis/projects?$top=1',
        operation: 'health_check',
        context,
      });
      return true;
    } catch {
      return false;
    }
  }

  public async listProjects(context: RequestContext, organization?: string): Promise<unknown[]> {
    const response = await this.request(compactObject({
      organization,
      path: '/_apis/projects?$top=100',
      operation: 'list_projects',
      context,
    }));

    return this.getArrayValue(response, 'value');
  }

  public async getWorkItem(
    context: RequestContext,
    args: { organization?: string; id: number; fields?: string[]; expandRelations?: boolean },
  ): Promise<unknown> {
    const fieldList = args.fields?.length ? args.fields : [...defaultFieldRefs];
    const params = new URLSearchParams({
      fields: fieldList.join(','),
      'api-version': '7.1',
    });

    if (args.expandRelations) {
      params.set('$expand', 'relations');
    }

    return this.request(compactObject({
      organization: args.organization,
      path: `/_apis/wit/workitems/${args.id}?${params.toString()}`,
      operation: 'get_work_item',
      context,
    }));
  }

  public async getWorkItems(
    context: RequestContext,
    args: { organization?: string; ids: number[]; fields?: string[] },
  ): Promise<unknown[]> {
    const fieldList = args.fields?.length ? args.fields : [...defaultFieldRefs];
    const response = await this.request(compactObject({
      organization: args.organization,
      path: '/_apis/wit/workitemsbatch',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ids: args.ids,
        fields: fieldList,
      }),
      timeoutMs: this.config.bulkRequestTimeoutMs,
      operation: 'get_work_items',
      context,
    }));

    return this.getArrayValue(response, 'value');
  }

  public async queryByWiql(
    context: RequestContext,
    args: { organization?: string; project?: string; query: string; top?: number },
  ): Promise<unknown> {
    const projectPath = this.resolveProjectPath(args.project);
    const query = validateWiql(args.query);

    return this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${projectPath}/_apis/wit/wiql${args.top ? `?$top=${args.top}` : ''}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query }),
      timeoutMs: this.config.bulkRequestTimeoutMs,
      operation: 'query_work_items',
      context,
    }));
  }

  public async createWorkItem(
    context: RequestContext,
    args: {
      organization?: string;
      project?: string;
      type: string;
      patchDocument: Array<Record<string, unknown>>;
    },
  ): Promise<unknown> {
    return this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${this.resolveProjectPath(args.project)}/_apis/wit/workitems/$${encodeURIComponent(
        args.type,
      )}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json-patch+json',
      },
      body: JSON.stringify(args.patchDocument),
      operation: 'create_work_item',
      context,
    }));
  }

  public async updateWorkItem(
    context: RequestContext,
    args: {
      organization?: string;
      project?: string;
      id: number;
      patchDocument: Array<Record<string, unknown>>;
    },
  ): Promise<unknown> {
    return this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${this.resolveProjectPath(args.project)}/_apis/wit/workitems/${args.id}`,
      method: 'PATCH',
      headers: {
        'content-type': 'application/json-patch+json',
      },
      body: JSON.stringify(args.patchDocument),
      operation: 'update_work_item',
      context,
    }));
  }

  public async deleteWorkItem(
    context: RequestContext,
    args: { organization?: string; project?: string; id: number; destroy?: boolean },
  ): Promise<unknown> {
    const query = args.destroy ? '?destroy=true' : '';
    return this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${this.resolveProjectPath(args.project)}/_apis/wit/workitems/${args.id}${query}`,
      method: 'DELETE',
      operation: 'delete_work_item',
      context,
    }));
  }

  public async getComments(
    context: RequestContext,
    args: { organization?: string; project?: string; id: number },
  ): Promise<unknown[]> {
    const response = await this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${this.resolveProjectPath(args.project)}/_apis/wit/workItems/${args.id}/comments`,
      operation: 'get_comments',
      context,
    }));

    return this.getArrayValue(response, 'comments');
  }

  public async addComment(
    context: RequestContext,
    args: { organization?: string; project?: string; id: number; text: string },
  ): Promise<unknown> {
    return this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${this.resolveProjectPath(args.project)}/_apis/wit/workItems/${args.id}/comments`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: args.text }),
      operation: 'add_comment',
      context,
    }));
  }

  public async listWorkItemTypes(
    context: RequestContext,
    args: { organization?: string; project?: string },
  ): Promise<unknown[]> {
    const response = await this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${this.resolveProjectPath(args.project)}/_apis/wit/workitemtypes`,
      operation: 'list_work_item_types',
      context,
      timeoutMs: this.config.bulkRequestTimeoutMs,
    }));

    return this.getArrayValue(response, 'value');
  }

  public async listWorkItemTypeStates(
    context: RequestContext,
    args: { organization?: string; project?: string; type: string },
  ): Promise<unknown[]> {
    const response = await this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${this.resolveProjectPath(args.project)}/_apis/wit/workitemtypes/${encodeURIComponent(
        args.type,
      )}/states`,
      operation: 'list_work_item_type_states',
      context,
      timeoutMs: this.config.bulkRequestTimeoutMs,
    }));

    return this.getArrayValue(response, 'value');
  }

  public async listWorkItemTypeFields(
    context: RequestContext,
    args: { organization?: string; project?: string; type: string },
  ): Promise<unknown[]> {
    const response = await this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${this.resolveProjectPath(args.project)}/_apis/wit/workitemtypes/${encodeURIComponent(
        args.type,
      )}/fields`,
      operation: 'list_work_item_type_fields',
      context,
      timeoutMs: this.config.bulkRequestTimeoutMs,
    }));

    return this.getArrayValue(response, 'value');
  }

  public async listClassificationNodes(
    context: RequestContext,
    args: { organization?: string; project?: string; structureGroup: 'areas' | 'iterations' },
  ): Promise<unknown> {
    return this.request(compactObject({
      organization: args.organization,
      project: args.project,
      path: `${this.resolveProjectPath(args.project)}/_apis/wit/classificationnodes/${
        args.structureGroup
      }?$depth=10`,
      operation: `list_${args.structureGroup}`,
      context,
      timeoutMs: this.config.bulkRequestTimeoutMs,
    }));
  }

  public async ensureFieldsExist(
    context: RequestContext,
    organization: string | undefined,
    refs: string[],
  ): Promise<void> {
    if (refs.length === 0) {
      return;
    }

    const cacheKey = buildOrganizationUrl(this.config.azureDevopsOrgUrl, organization);
    let knownFields = this.knownFieldsCache.get(cacheKey);

    if (!knownFields) {
      const response = await this.request(compactObject({
        organization,
        path: '/_apis/wit/fields',
        operation: 'list_fields',
        context,
        timeoutMs: this.config.bulkRequestTimeoutMs,
      }));

      knownFields = new Set(
        this.getArrayValue(response, 'value')
          .map((field) => (field as AzureFieldReference).referenceName)
          .filter((field): field is string => typeof field === 'string'),
      );
      this.knownFieldsCache.set(cacheKey, knownFields);
    }

    const unknown = refs.filter((ref) => !knownFields.has(ref));

    if (unknown.length > 0) {
      throw new McpError('VALIDATION_ERROR', 'Unknown Azure DevOps field reference names.', {
        details: { unknown },
      });
    }
  }

  public async downloadTlsConfig(): Promise<
    | {
        cert: Buffer;
        key: Buffer;
      }
    | undefined
  > {
    if (!this.config.mcpTlsCert || !this.config.mcpTlsKey) {
      return undefined;
    }

    const [cert, key] = await Promise.all([
      readFile(this.config.mcpTlsCert),
      readFile(this.config.mcpTlsKey),
    ]);

    return { cert, key };
  }

  private async request(options: RequestOptions): Promise<unknown> {
    const response = await this.breaker.fire(options);
    return response.json;
  }

  private async performRequest(options: RequestOptions): Promise<AzureDevOpsResponse> {
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs;
    const maxAttempts = this.config.maxRetryAttempts + 1;
    const baseUrl = buildOrganizationUrl(this.config.azureDevopsOrgUrl, options.organization);
    const url = new URL(`${baseUrl}${options.path}`);

    if (!url.searchParams.has('api-version')) {
      url.searchParams.set('api-version', options.apiVersion ?? '7.1');
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const headers = await this.buildHeaders(options.context, options.headers);
        this.logger.debug(
          {
            operation: options.operation,
            url: url.toString(),
            attempt,
          },
          'Sending Azure DevOps request',
        );
        const response = await fetch(url, compactObject({
          method: options.method ?? 'GET',
          headers,
          body: options.body,
          signal: controller.signal,
        }));

        const durationSeconds = (Date.now() - startedAt) / 1000;
        this.metrics.azureDevopsApiCallsTotal.inc({
          operation: options.operation,
          status_code: String(response.status),
        });
        this.metrics.azureDevopsApiDurationSeconds.observe(
          { operation: options.operation },
          durationSeconds,
        );

        if (response.status === 429) {
          this.metrics.azureDevopsRateLimitHitsTotal.inc();
        }

        if (response.ok) {
          return {
            status: response.status,
            json: response.status === 204 ? { success: true } : await response.json(),
          };
        }

        const details = await this.safeReadBody(response);

        if (this.isRetryable(response.status) && attempt < maxAttempts) {
          const retryAfter = response.headers.get('retry-after');
          const delayMs = retryAfter ? Number(retryAfter) * 1000 : 500 * 2 ** (attempt - 1);
          await wait(delayMs);
          continue;
        }

        throw new McpError(statusToErrorCode(response.status), response.statusText, {
          statusCode: response.status,
          details,
        });
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }

        if ((error as Error).name === 'AbortError') {
          throw new McpError('TIMEOUT', 'Azure DevOps request timed out.', {
            details: { operation: options.operation, timeoutMs },
          });
        }

        if (attempt < maxAttempts) {
          await wait(500 * 2 ** (attempt - 1));
          continue;
        }

        throw new McpError('AZURE_DEVOPS_ERROR', 'Azure DevOps request failed.', {
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    throw new McpError('AZURE_DEVOPS_ERROR', 'Azure DevOps request failed after retries.');
  }

  private async buildHeaders(
    context: RequestContext,
    customHeaders?: Record<string, string>,
  ): Promise<Record<string, string>> {
    const authorization = await this.getAuthorizationHeader();

    return {
      accept: 'application/json',
      authorization,
      'x-tfs-session': context.traceId,
      ...customHeaders,
    };
  }

  private async getAuthorizationHeader(): Promise<string> {
    if (this.config.azureDevopsPat) {
      const encoded = Buffer.from(`:${this.config.azureDevopsPat}`).toString('base64');
      return `Basic ${encoded}`;
    }

    const token =
      this.config.azureAuthMode === 'default'
        ? await this.defaultCredential.getToken(azureDevopsScope)
        : await this.getInteractiveAccessToken();
    if (!token?.token) {
      throw new McpError('UNAUTHORIZED', 'Unable to acquire Azure DevOps access token.');
    }

    return `Bearer ${token.token}`;
  }

  private async getInteractiveAccessToken(): Promise<{ token: string } | null> {
    const credential = await this.getInteractiveCredential();

    if (!this.hasInteractiveAuthenticationRecord) {
      await this.ensureInteractiveAuthentication();
    }

    try {
      return await credential.getToken(azureDevopsScope);
    } catch (error) {
      this.logger.warn(
        {
          error,
        },
        'Refreshing interactive Azure authentication',
      );
    }

    await this.ensureInteractiveAuthentication(true);
    return credential.getToken(azureDevopsScope);
  }

  private async getInteractiveCredential(): Promise<InteractiveBrowserCredential> {
    if (this.interactiveCredential) {
      return this.interactiveCredential;
    }

    const authenticationRecord = await this.loadAuthenticationRecord();
    this.hasInteractiveAuthenticationRecord = Boolean(authenticationRecord);
    this.interactiveCredential = new InteractiveBrowserCredential(
      this.buildInteractiveCredentialOptions(authenticationRecord),
    );

    return this.interactiveCredential;
  }

  private async ensureInteractiveAuthentication(force = false): Promise<void> {
    if (this.interactiveAuthenticationPromise) {
      await this.interactiveAuthenticationPromise;
      return;
    }

    if (!force && this.hasInteractiveAuthenticationRecord) {
      return;
    }

    this.interactiveAuthenticationPromise = this.authenticateInteractiveCredential().finally(() => {
      this.interactiveAuthenticationPromise = undefined;
    });
    await this.interactiveAuthenticationPromise;
  }

  private async authenticateInteractiveCredential(): Promise<void> {
    const credential = await this.getInteractiveCredential();
    const authenticationRecord = await credential.authenticate(azureDevopsScope);

    if (!authenticationRecord) {
      throw new McpError('UNAUTHORIZED', 'Azure interactive sign-in was canceled.');
    }

    await this.saveAuthenticationRecord(authenticationRecord);
    this.hasInteractiveAuthenticationRecord = true;
    this.interactiveCredential = new InteractiveBrowserCredential(
      this.buildInteractiveCredentialOptions(authenticationRecord),
    );
  }

  private async loadAuthenticationRecord(): Promise<AuthenticationRecord | undefined> {
    const authRecordPath = this.getAuthenticationRecordPath();

    try {
      const content = await readFile(authRecordPath, 'utf8');
      return deserializeAuthenticationRecord(content);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return undefined;
      }

      this.logger.warn(
        {
          authRecordPath,
          error,
        },
        'Ignoring unreadable Azure authentication record',
      );
      return undefined;
    }
  }

  private async saveAuthenticationRecord(authenticationRecord: AuthenticationRecord): Promise<void> {
    const authRecordPath = this.getAuthenticationRecordPath();
    await mkdir(path.dirname(authRecordPath), { recursive: true });
    await writeFile(authRecordPath, serializeAuthenticationRecord(authenticationRecord), 'utf8');
  }

  private getAuthenticationRecordPath(): string {
    return (
      this.config.azureAuthRecordPath ??
      path.join(homedir(), '.azure-devops-mcp', 'authentication-record.json')
    );
  }

  private buildInteractiveCredentialOptions(
    authenticationRecord?: AuthenticationRecord,
  ): InteractiveBrowserCredentialNodeOptions {
    return compactObject({
      clientId: this.config.azureClientId,
      tenantId: this.config.azureTenantId,
      authenticationRecord,
      tokenCachePersistenceOptions: {
        enabled: true,
        name: tokenCacheName,
      },
    });
  }

  private async safeReadBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  private isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private resolveProjectPath(project?: string): string {
    const resolved = project ?? this.config.azureDevopsDefaultProject;
    if (!resolved) {
      throw new McpError(
        'VALIDATION_ERROR',
        'Project is required when AZURE_DEVOPS_DEFAULT_PROJECT is not configured.',
      );
    }

    return `/${encodeURIComponent(resolved)}`;
  }

  private getArrayValue(payload: unknown, key: string): unknown[] {
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>)[key])) {
      return [];
    }

    return (payload as Record<string, unknown>)[key] as unknown[];
  }
}
