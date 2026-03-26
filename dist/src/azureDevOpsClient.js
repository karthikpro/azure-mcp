import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { DefaultAzureCredential, InteractiveBrowserCredential, deserializeAuthenticationRecord, serializeAuthenticationRecord, } from '@azure/identity';
import CircuitBreaker from 'opossum';
import { McpError } from './errors.js';
import { buildOrganizationUrl, compactObject, defaultFieldRefs, statusToErrorCode, validateWiql, wait, } from './utils.js';
const azureDevopsScope = '499b84ac-1321-427f-aa17-267ca6975798/.default';
export class AzureDevOpsClient {
    config;
    logger;
    metrics;
    defaultCredential = new DefaultAzureCredential();
    breaker;
    knownFieldsCache = new Map();
    interactiveCredential;
    hasInteractiveAuthenticationRecord = false;
    interactiveAuthenticationPromise;
    constructor(config, logger, metrics) {
        this.config = config;
        this.logger = logger;
        this.metrics = metrics;
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
    async checkReady(context) {
        try {
            await this.request({
                path: '/_apis/projects?$top=1',
                operation: 'health_check',
                context,
            });
            return true;
        }
        catch {
            return false;
        }
    }
    async listProjects(context, organization) {
        const response = await this.request(compactObject({
            organization,
            path: '/_apis/projects?$top=100',
            operation: 'list_projects',
            context,
        }));
        return this.getArrayValue(response, 'value');
    }
    async getWorkItem(context, args) {
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
    async getWorkItems(context, args) {
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
    async queryByWiql(context, args) {
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
    async createWorkItem(context, args) {
        return this.request(compactObject({
            organization: args.organization,
            project: args.project,
            path: `${this.resolveProjectPath(args.project)}/_apis/wit/workitems/$${encodeURIComponent(args.type)}`,
            method: 'POST',
            headers: {
                'content-type': 'application/json-patch+json',
            },
            body: JSON.stringify(args.patchDocument),
            operation: 'create_work_item',
            context,
        }));
    }
    async updateWorkItem(context, args) {
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
    async deleteWorkItem(context, args) {
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
    async getComments(context, args) {
        const response = await this.request(compactObject({
            organization: args.organization,
            project: args.project,
            path: `${this.resolveProjectPath(args.project)}/_apis/wit/workItems/${args.id}/comments`,
            operation: 'get_comments',
            context,
        }));
        return this.getArrayValue(response, 'comments');
    }
    async addComment(context, args) {
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
    async listWorkItemTypes(context, args) {
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
    async listWorkItemTypeStates(context, args) {
        const response = await this.request(compactObject({
            organization: args.organization,
            project: args.project,
            path: `${this.resolveProjectPath(args.project)}/_apis/wit/workitemtypes/${encodeURIComponent(args.type)}/states`,
            operation: 'list_work_item_type_states',
            context,
            timeoutMs: this.config.bulkRequestTimeoutMs,
        }));
        return this.getArrayValue(response, 'value');
    }
    async listWorkItemTypeFields(context, args) {
        const response = await this.request(compactObject({
            organization: args.organization,
            project: args.project,
            path: `${this.resolveProjectPath(args.project)}/_apis/wit/workitemtypes/${encodeURIComponent(args.type)}/fields`,
            operation: 'list_work_item_type_fields',
            context,
            timeoutMs: this.config.bulkRequestTimeoutMs,
        }));
        return this.getArrayValue(response, 'value');
    }
    async listClassificationNodes(context, args) {
        return this.request(compactObject({
            organization: args.organization,
            project: args.project,
            path: `${this.resolveProjectPath(args.project)}/_apis/wit/classificationnodes/${args.structureGroup}?$depth=10`,
            operation: `list_${args.structureGroup}`,
            context,
            timeoutMs: this.config.bulkRequestTimeoutMs,
        }));
    }
    async ensureFieldsExist(context, organization, refs) {
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
            knownFields = new Set(this.getArrayValue(response, 'value')
                .map((field) => field.referenceName)
                .filter((field) => typeof field === 'string'));
            this.knownFieldsCache.set(cacheKey, knownFields);
        }
        const unknown = refs.filter((ref) => !knownFields.has(ref));
        if (unknown.length > 0) {
            throw new McpError('VALIDATION_ERROR', 'Unknown Azure DevOps field reference names.', {
                details: { unknown },
            });
        }
    }
    async downloadTlsConfig() {
        if (!this.config.mcpTlsCert || !this.config.mcpTlsKey) {
            return undefined;
        }
        const [cert, key] = await Promise.all([
            readFile(this.config.mcpTlsCert),
            readFile(this.config.mcpTlsKey),
        ]);
        return { cert, key };
    }
    async request(options) {
        const response = await this.breaker.fire(options);
        return response.json;
    }
    async performRequest(options) {
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
                this.logger.debug({
                    operation: options.operation,
                    url: url.toString(),
                    attempt,
                }, 'Sending Azure DevOps request');
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
                this.metrics.azureDevopsApiDurationSeconds.observe({ operation: options.operation }, durationSeconds);
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
            }
            catch (error) {
                if (error instanceof McpError) {
                    throw error;
                }
                if (error.name === 'AbortError') {
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
            }
            finally {
                clearTimeout(timer);
            }
        }
        throw new McpError('AZURE_DEVOPS_ERROR', 'Azure DevOps request failed after retries.');
    }
    async buildHeaders(context, customHeaders) {
        const authorization = await this.getAuthorizationHeader();
        return {
            accept: 'application/json',
            authorization,
            'x-tfs-session': context.traceId,
            ...customHeaders,
        };
    }
    async getAuthorizationHeader() {
        if (this.config.azureDevopsPat) {
            const encoded = Buffer.from(`:${this.config.azureDevopsPat}`).toString('base64');
            return `Basic ${encoded}`;
        }
        const token = this.config.azureAuthMode === 'default'
            ? await this.defaultCredential.getToken(azureDevopsScope)
            : await this.getInteractiveAccessToken();
        if (!token?.token) {
            throw new McpError('UNAUTHORIZED', 'Unable to acquire Azure DevOps access token.');
        }
        return `Bearer ${token.token}`;
    }
    async getInteractiveAccessToken() {
        const credential = await this.getInteractiveCredential();
        if (!this.hasInteractiveAuthenticationRecord) {
            await this.ensureInteractiveAuthentication();
        }
        try {
            return await credential.getToken(azureDevopsScope);
        }
        catch (error) {
            this.logger.warn({
                error,
            }, 'Refreshing interactive Azure authentication');
        }
        await this.ensureInteractiveAuthentication(true);
        return credential.getToken(azureDevopsScope);
    }
    async getInteractiveCredential() {
        if (this.interactiveCredential) {
            return this.interactiveCredential;
        }
        const authenticationRecord = await this.loadAuthenticationRecord();
        this.hasInteractiveAuthenticationRecord = Boolean(authenticationRecord);
        this.interactiveCredential = new InteractiveBrowserCredential(compactObject({
            clientId: this.config.azureClientId,
            tenantId: this.config.azureTenantId,
            authenticationRecord,
        }));
        return this.interactiveCredential;
    }
    async ensureInteractiveAuthentication(force = false) {
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
    async authenticateInteractiveCredential() {
        const credential = await this.getInteractiveCredential();
        const authenticationRecord = await credential.authenticate(azureDevopsScope);
        if (!authenticationRecord) {
            throw new McpError('UNAUTHORIZED', 'Azure interactive sign-in was canceled.');
        }
        await this.saveAuthenticationRecord(authenticationRecord);
        this.hasInteractiveAuthenticationRecord = true;
        this.interactiveCredential = new InteractiveBrowserCredential(compactObject({
            clientId: this.config.azureClientId,
            tenantId: this.config.azureTenantId,
            authenticationRecord,
        }));
    }
    async loadAuthenticationRecord() {
        const authRecordPath = this.getAuthenticationRecordPath();
        try {
            const content = await readFile(authRecordPath, 'utf8');
            return deserializeAuthenticationRecord(content);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return undefined;
            }
            this.logger.warn({
                authRecordPath,
                error,
            }, 'Ignoring unreadable Azure authentication record');
            return undefined;
        }
    }
    async saveAuthenticationRecord(authenticationRecord) {
        const authRecordPath = this.getAuthenticationRecordPath();
        await mkdir(path.dirname(authRecordPath), { recursive: true });
        await writeFile(authRecordPath, serializeAuthenticationRecord(authenticationRecord), 'utf8');
    }
    getAuthenticationRecordPath() {
        return (this.config.azureAuthRecordPath ??
            path.join(homedir(), '.azure-devops-mcp', 'authentication-record.json'));
    }
    async safeReadBody(response) {
        try {
            return await response.json();
        }
        catch {
            return await response.text();
        }
    }
    isRetryable(status) {
        return status === 429 || status >= 500;
    }
    resolveProjectPath(project) {
        const resolved = project ?? this.config.azureDevopsDefaultProject;
        if (!resolved) {
            throw new McpError('VALIDATION_ERROR', 'Project is required when AZURE_DEVOPS_DEFAULT_PROJECT is not configured.');
        }
        return `/${encodeURIComponent(resolved)}`;
    }
    getArrayValue(payload, key) {
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload[key])) {
            return [];
        }
        return payload[key];
    }
}
