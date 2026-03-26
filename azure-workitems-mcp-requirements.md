# Azure DevOps Work Items MCP Server — Product Requirements Document

**Document Version:** 1.0.0  
**Status:** Draft for Review  
**Last Updated:** 2026-03-26  
**Owner:** Platform Engineering  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Background & Motivation](#2-background--motivation)
3. [Scope](#3-scope)
4. [Stakeholders](#4-stakeholders)
5. [Functional Requirements](#5-functional-requirements)
6. [Non-Functional Requirements](#6-non-functional-requirements)
7. [System Architecture](#7-system-architecture)
8. [API & Tool Specification](#8-api--tool-specification)
9. [Authentication & Authorization](#9-authentication--authorization)
10. [Error Handling & Resilience](#10-error-handling--resilience)
11. [Observability & Monitoring](#11-observability--monitoring)
12. [Security Requirements](#12-security-requirements)
13. [Configuration & Environment](#13-configuration--environment)
14. [Project Structure](#14-project-structure)
15. [Development Standards](#15-development-standards)
16. [Testing Strategy](#16-testing-strategy)
17. [CI/CD Pipeline](#17-cicd-pipeline)
18. [Deployment & Distribution](#18-deployment--distribution)
19. [Documentation Requirements](#19-documentation-requirements)
20. [Acceptance Criteria](#20-acceptance-criteria)
21. [Milestones & Timeline](#21-milestones--timeline)
22. [Open Questions & Risks](#22-open-questions--risks)
23. [Appendix](#23-appendix)

---

## 1. Executive Summary

This document specifies the requirements for building a production-grade **Model Context Protocol (MCP) server** in Node.js that enables AI assistants (Claude, Copilot, Cursor, etc.) to interact with **Azure DevOps Work Items** via a standardized, secure, and observable tool interface.

The server exposes structured MCP tools for reading, creating, updating, querying, and managing Azure DevOps Work Items. It targets engineering teams that want their AI-assisted workflows to stay in sync with their Azure DevOps project management without leaving the AI context.

---

## 2. Background & Motivation

### 2.1 Problem Statement

Engineering teams using Azure DevOps for project tracking face a context-switching burden when AI assistants cannot directly access or mutate work items. Developers must manually copy information between their AI assistant and Azure DevOps, increasing cognitive load and the risk of stale data.

### 2.2 Model Context Protocol Overview

MCP (Model Context Protocol) is an open standard for connecting AI models to external data sources and tools. An MCP server exposes **tools** (actions) and **resources** (data) that AI clients can invoke. This project implements the server side of that protocol for Azure DevOps Work Items.

### 2.3 Why Node.js

- Native async/await aligns with Azure DevOps REST API patterns
- Rich ecosystem: `@azure/identity`, `azure-devops-node-api`, `@modelcontextprotocol/sdk`
- Fast cold-start for CLI-spawned MCP server processes
- Single runtime for both the MCP transport layer and Azure SDK calls

---

## 3. Scope

### 3.1 In Scope

| Area | Description |
|------|-------------|
| Work Item CRUD | Read, create, update, and delete work items |
| Querying | WIQL-based and structured query execution |
| Comments | Read and post comments on work items |
| Attachments | List and download attachments |
| Iterations & Areas | Read sprint and area path metadata |
| Linked Items | Read and manage work item relations |
| Batch Operations | Bulk update support (up to 200 items) |
| MCP Transport | stdio and HTTP/SSE transports |
| Auth | PAT, Azure AD (MSAL), Managed Identity |
| Observability | Structured logging, metrics, health checks |
| Distribution | npm package + Docker image |

### 3.2 Out of Scope (v1.0)

- Azure Boards dashboards
- Pipeline / build management
- Repository / PR operations
- Test Plans
- Wiki management
- Real-time webhooks (planned for v1.1)

---

## 4. Stakeholders

| Role | Name / Team | Interest |
|------|-------------|----------|
| Product Owner | Platform Engineering Lead | Delivery & scope |
| Primary Users | Developers using AI assistants | Daily workflow integration |
| Azure DevOps Admins | IT / DevOps team | Auth, permissions, rate limits |
| Security Team | InfoSec | Auth, secrets, data handling |
| MCP Client Teams | Claude, Cursor, Copilot integrators | API contract stability |

---

## 5. Functional Requirements

### 5.1 Work Item — Read

**FR-001** The server MUST expose a `get_work_item` tool that retrieves a single work item by ID.

**FR-002** The `get_work_item` tool MUST return: ID, title, type, state, assigned-to, area path, iteration path, priority, tags, description (HTML stripped to plain text), and timestamps (created, changed).

**FR-003** The server MUST expose a `get_work_items` tool accepting a list of IDs (max 200) and returning the same fields as FR-002 for each item.

**FR-004** Field expansion MUST be controllable via an `fields` parameter accepting an array of Azure DevOps field reference names (e.g., `System.Title`, `Microsoft.VSTS.Common.Priority`).

### 5.2 Work Item — Query

**FR-005** The server MUST expose a `query_work_items` tool accepting a WIQL query string and returning matching work item IDs with summary fields.

**FR-006** The server MUST expose a `list_work_items` tool with structured filter parameters: `project`, `type`, `state`, `assignedTo`, `iteration`, `areaPath`, `tags`, `createdAfter`, `changedAfter`, `top` (default 50, max 200), `skip`.

**FR-007** Query results MUST include a `totalCount` and a `hasMore` boolean to support pagination.

### 5.3 Work Item — Create

**FR-008** The server MUST expose a `create_work_item` tool accepting: `project` (required), `type` (required), `title` (required), `description`, `assignedTo`, `areaPath`, `iterationPath`, `priority`, `tags`, `parent` (ID), and an arbitrary `fields` key-value map for additional field values.

**FR-009** On success, `create_work_item` MUST return the full work item object (same fields as FR-002) including the newly assigned ID.

**FR-010** Validation MUST reject unknown field references and surface Azure DevOps validation errors verbatim in the tool response.

### 5.4 Work Item — Update

**FR-011** The server MUST expose an `update_work_item` tool accepting: `id` (required), and any subset of updateable fields: `title`, `description`, `state`, `assignedTo`, `areaPath`, `iterationPath`, `priority`, `tags`, plus an arbitrary `fields` map.

**FR-012** `update_work_item` MUST use optimistic concurrency: it MUST accept an optional `rev` (revision number) and fail with a `CONFLICT` error if the server revision has advanced.

**FR-013** The server MUST expose a `bulk_update_work_items` tool accepting an array of update objects (each with `id` and fields to change), capped at 200 items.

**FR-014** `bulk_update_work_items` MUST execute updates as a single Azure DevOps batch request where the API supports it, and return per-item success/failure status.

### 5.5 Work Item — Delete

**FR-015** The server MUST expose a `delete_work_item` tool accepting `id` and optional `destroy` boolean (default `false`). When `destroy` is `false`, the item is moved to the recycle bin.

**FR-016** Delete operations MUST require an explicit `confirm: true` parameter to prevent accidental deletion.

### 5.6 Comments

**FR-017** The server MUST expose a `get_comments` tool returning all comments for a work item ID, including author, timestamp, and text.

**FR-018** The server MUST expose an `add_comment` tool accepting `id` and `text` (Markdown supported).

### 5.7 Relations & Links

**FR-019** The server MUST expose a `get_relations` tool returning all links (child, parent, related, predecessor, successor, duplicate) for a work item.

**FR-020** The server MUST expose an `add_relation` tool accepting `sourceId`, `targetId`, and `relationType`.

**FR-021** The server MUST expose a `remove_relation` tool accepting `sourceId`, `targetId`, and `relationType`.

### 5.8 Metadata & Discovery

**FR-022** The server MUST expose a `list_projects` tool returning all accessible Azure DevOps projects.

**FR-023** The server MUST expose a `list_work_item_types` tool returning all work item types for a given project (name, description, icon, states, fields).

**FR-024** The server MUST expose a `list_iterations` tool returning sprints/iterations for a project and optional team.

**FR-025** The server MUST expose a `list_area_paths` tool returning the area path tree for a project.

### 5.9 MCP Protocol Compliance

**FR-026** The server MUST implement the MCP specification version `2024-11-05` or later.

**FR-027** The server MUST support both **stdio** transport (for local AI assistant clients) and **HTTP/SSE** transport (for remote/hosted clients).

**FR-028** The server MUST implement MCP `tools/list` returning all tools with JSON Schema input definitions and human-readable descriptions.

**FR-029** The server MUST implement MCP `resources/list` and `resources/read` for surfacing work item data as resources addressable by URI (e.g., `azure-devops://org/project/workitems/42`).

**FR-030** The server MUST implement MCP `prompts/list` with pre-built prompt templates: `summarize_sprint`, `triage_bugs`, `draft_work_item`.

---

## 6. Non-Functional Requirements

### 6.1 Performance

| Metric | Target |
|--------|--------|
| Single work item read (p95) | < 500 ms |
| Bulk read 200 items (p95) | < 3 s |
| Query execution (p95) | < 2 s |
| Server cold start (stdio) | < 800 ms |
| Memory usage (idle) | < 80 MB RSS |

### 6.2 Reliability

**NFR-001** The server MUST implement automatic retry with exponential backoff (max 3 retries, initial delay 500 ms) for Azure DevOps API calls that return 429 (rate limited) or 5xx responses.

**NFR-002** The server MUST honor `Retry-After` headers from Azure DevOps rate limit responses.

**NFR-003** The server MUST implement request timeouts: 10 s for single-item operations, 30 s for bulk/query operations.

**NFR-004** Token refresh MUST be handled transparently with zero MCP request failures attributable to token expiry.

### 6.3 Scalability

**NFR-005** The HTTP/SSE transport MUST support at least 50 concurrent MCP sessions per instance.

**NFR-006** Connection pooling MUST be enabled for Azure DevOps HTTP connections.

### 6.4 Compatibility

**NFR-007** The server MUST run on Node.js 20 LTS and Node.js 22 LTS.

**NFR-008** The server MUST run on Linux (x86_64, arm64), macOS (x86_64, arm64), and Windows (x86_64).

**NFR-009** The server MUST support Azure DevOps Services (cloud) and Azure DevOps Server 2022+ (on-premises).

---

## 7. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Client                               │
│         (Claude Desktop / Cursor / VS Code / Custom)            │
└───────────────────────┬─────────────────────────────────────────┘
                        │  MCP Protocol (stdio or HTTP/SSE)
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                  MCP Server (Node.js)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Transport   │  │   Protocol   │  │   Tool Registry      │  │
│  │  Layer       │  │   Handler    │  │   (tools/list,       │  │
│  │  (stdio/SSE) │  │   (MCP SDK)  │  │    tools/call)       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         └─────────────────┴──────────────────────┘              │
│                           │                                      │
│  ┌────────────────────────▼──────────────────────────────────┐  │
│  │                  Service Layer                            │  │
│  │  WorkItemService │ QueryService │ CommentService │ Meta   │  │
│  └────────────────────────┬──────────────────────────────────┘  │
│                           │                                      │
│  ┌────────────────────────▼──────────────────────────────────┐  │
│  │                Azure DevOps Client                        │  │
│  │  azure-devops-node-api + retry/rate-limit middleware      │  │
│  └────────────────────────┬──────────────────────────────────┘  │
│                           │                                      │
│  ┌──────────────────────┐ │ ┌────────────────────────────────┐  │
│  │   Auth Provider      │ │ │    Config / Secrets Manager    │  │
│  │  PAT / MSAL / MI     │ └─│    (env vars / Key Vault)      │  │
│  └──────────────────────┘   └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                        │  HTTPS REST / PATCH
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Azure DevOps Services                        │
│              (Work Items REST API v7.1)                         │
└─────────────────────────────────────────────────────────────────┘
```

### 7.1 Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| MCP SDK | `@modelcontextprotocol/sdk` | Official SDK, maintained by Anthropic |
| Azure Client | `azure-devops-node-api` | Official Microsoft library |
| Auth | `@azure/identity` | Unified credential chain |
| Validation | `zod` | Runtime schema validation with TypeScript inference |
| Logging | `pino` | High-performance structured JSON logging |
| Testing | `vitest` | Fast, ESM-native |
| Linting | `eslint` + `@typescript-eslint` | Industry standard |
| Formatting | `prettier` | Consistent code style |
| Bundling | `tsup` | Zero-config TypeScript bundler |

---

## 8. API & Tool Specification

### 8.1 Tool Input/Output Contracts

All tools MUST conform to JSON Schema Draft-07 for their `inputSchema`. All tool responses MUST return a `content` array per the MCP specification.

#### `get_work_item`

```json
{
  "name": "get_work_item",
  "description": "Retrieve a single Azure DevOps work item by ID.",
  "inputSchema": {
    "type": "object",
    "required": ["organization", "project", "id"],
    "properties": {
      "organization": { "type": "string", "description": "Azure DevOps organization name" },
      "project":      { "type": "string", "description": "Project name or ID" },
      "id":           { "type": "integer", "description": "Work item ID" },
      "fields":       { "type": "array", "items": { "type": "string" },
                        "description": "Field reference names to include (default: standard set)" }
    }
  }
}
```

#### `list_work_items`

```json
{
  "name": "list_work_items",
  "description": "Query work items using structured filters without writing WIQL.",
  "inputSchema": {
    "type": "object",
    "required": ["organization", "project"],
    "properties": {
      "organization":  { "type": "string" },
      "project":       { "type": "string" },
      "type":          { "type": "string", "description": "e.g. Bug, User Story, Task" },
      "state":         { "type": "string", "description": "e.g. Active, Resolved, Closed" },
      "assignedTo":    { "type": "string", "description": "UPN or display name; '@me' for current user" },
      "iteration":     { "type": "string", "description": "Full iteration path" },
      "areaPath":      { "type": "string" },
      "tags":          { "type": "array", "items": { "type": "string" } },
      "createdAfter":  { "type": "string", "format": "date-time" },
      "changedAfter":  { "type": "string", "format": "date-time" },
      "top":           { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
      "skip":          { "type": "integer", "minimum": 0, "default": 0 }
    }
  }
}
```

#### `create_work_item`

```json
{
  "name": "create_work_item",
  "description": "Create a new work item.",
  "inputSchema": {
    "type": "object",
    "required": ["organization", "project", "type", "title"],
    "properties": {
      "organization":  { "type": "string" },
      "project":       { "type": "string" },
      "type":          { "type": "string" },
      "title":         { "type": "string", "minLength": 1, "maxLength": 255 },
      "description":   { "type": "string" },
      "assignedTo":    { "type": "string" },
      "areaPath":      { "type": "string" },
      "iterationPath": { "type": "string" },
      "priority":      { "type": "integer", "minimum": 1, "maximum": 4 },
      "tags":          { "type": "array", "items": { "type": "string" } },
      "parent":        { "type": "integer", "description": "Parent work item ID" },
      "fields":        { "type": "object", "additionalProperties": true,
                         "description": "Additional field key-value pairs" }
    }
  }
}
```

#### `update_work_item`

```json
{
  "name": "update_work_item",
  "description": "Update an existing work item. Only provided fields are changed.",
  "inputSchema": {
    "type": "object",
    "required": ["organization", "project", "id"],
    "properties": {
      "organization":  { "type": "string" },
      "project":       { "type": "string" },
      "id":            { "type": "integer" },
      "rev":           { "type": "integer", "description": "Expected revision for optimistic concurrency" },
      "title":         { "type": "string" },
      "description":   { "type": "string" },
      "state":         { "type": "string" },
      "assignedTo":    { "type": "string" },
      "areaPath":      { "type": "string" },
      "iterationPath": { "type": "string" },
      "priority":      { "type": "integer", "minimum": 1, "maximum": 4 },
      "tags":          { "type": "array", "items": { "type": "string" } },
      "fields":        { "type": "object", "additionalProperties": true }
    }
  }
}
```

#### Error Response Shape

All tool errors MUST return a structured error in the content array:

```json
{
  "content": [
    {
      "type": "text",
      "text": "ERROR: [ERROR_CODE] Human-readable message.\nDetails: { ... }"
    }
  ],
  "isError": true
}
```

**Defined error codes:** `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR`, `CONFLICT`, `RATE_LIMITED`, `TIMEOUT`, `AZURE_DEVOPS_ERROR`, `INTERNAL_ERROR`.

---

## 9. Authentication & Authorization

### 9.1 Supported Authentication Methods

| Method | Use Case | Config |
|--------|----------|--------|
| Personal Access Token (PAT) | Local dev, service accounts | `AZURE_DEVOPS_PAT` env var |
| Azure AD App (client credentials) | Automated pipelines | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` |
| Managed Identity | Azure-hosted deployments | Auto-detected via `@azure/identity` |
| Azure CLI credential | Developer workstations | Auto-detected via DefaultAzureCredential |

### 9.2 Credential Resolution Order

The server MUST use `DefaultAzureCredential` from `@azure/identity` as the fallback chain when no PAT is supplied. When a PAT is supplied, it takes precedence.

### 9.3 Required Azure DevOps Scopes

| Permission | Required For |
|-----------|-------------|
| `vso.work_read` | All read operations |
| `vso.work_write` | Create / Update operations |
| `vso.work_full` | Delete operations |
| `vso.project_read` | list_projects, metadata |

### 9.4 Secrets Management

**SEC-001** PATs and client secrets MUST NOT be hard-coded or logged at any log level.

**SEC-002** The server MUST support loading secrets from environment variables, `.env` files (dev only), and Azure Key Vault (via `AZURE_KEYVAULT_URI` env var).

**SEC-003** On Key Vault integration, secrets MUST be cached with a TTL of 5 minutes and refreshed transparently.

---

## 10. Error Handling & Resilience

### 10.1 Retry Strategy

```
Attempt 1 ──► fail (5xx/429) ──► wait 500ms
Attempt 2 ──► fail (5xx/429) ──► wait 1000ms
Attempt 3 ──► fail (5xx/429) ──► wait 2000ms
Attempt 4 ──► fail ──► surface error to MCP client
```

Non-retryable: 400, 401, 403, 404, 409 (conflict).

### 10.2 Circuit Breaker

**NFR-010** The server MUST implement a circuit breaker (using `opossum` or equivalent) for Azure DevOps API calls:

- **Closed** (normal): requests pass through.
- **Open** (triggered after 5 consecutive failures in 30 s): fail fast with `AZURE_DEVOPS_ERROR`.
- **Half-Open** (after 60 s): probe with single request; reclose on success.

### 10.3 Graceful Degradation

**NFR-011** When the Azure DevOps API is unreachable, all tool calls MUST return a structured `AZURE_DEVOPS_ERROR` response rather than crashing the MCP server process.

**NFR-012** The server MUST handle SIGTERM and SIGINT gracefully: complete in-flight requests (up to 10 s), then shut down cleanly.

---

## 11. Observability & Monitoring

### 11.1 Structured Logging

**OBS-001** All log output MUST use `pino` with JSON format at INFO level and above in production.

**OBS-002** Each log entry MUST include: `timestamp`, `level`, `service` (`azure-devops-mcp`), `version`, `traceId`, `toolName` (where applicable), `durationMs`.

**OBS-003** Sensitive fields (PAT fragments, email addresses, Azure credentials) MUST be redacted before logging.

**OBS-004** Log levels MUST be configurable via `LOG_LEVEL` env var (trace, debug, info, warn, error, fatal).

### 11.2 Metrics

**OBS-005** When running in HTTP mode, the server MUST expose a `/metrics` endpoint in Prometheus text format with:

| Metric | Type | Description |
|--------|------|-------------|
| `mcp_tool_calls_total` | Counter | Total tool invocations, labeled by `tool`, `status` |
| `mcp_tool_duration_seconds` | Histogram | Latency per tool call |
| `azure_devops_api_calls_total` | Counter | Labeled by `operation`, `status_code` |
| `azure_devops_api_duration_seconds` | Histogram | Azure API latency |
| `azure_devops_rate_limit_hits_total` | Counter | 429 responses |
| `circuit_breaker_state` | Gauge | 0=closed, 1=half-open, 2=open |

### 11.3 Health Check

**OBS-006** The HTTP transport MUST expose `/health` (liveness) and `/ready` (readiness) endpoints.

- `/health`: returns `200 OK` if the process is running.
- `/ready`: returns `200 OK` only if the Azure DevOps token is valid and the configured organization is reachable; returns `503` otherwise.

### 11.4 Request Tracing

**OBS-007** Each MCP tool call MUST generate a `traceId` (UUID v4) that is propagated in all Azure DevOps API calls via the `X-TFS-Session` header.

---

## 12. Security Requirements

**SEC-004** The server MUST validate and sanitize all tool input parameters using Zod schemas before passing them to the Azure DevOps SDK.

**SEC-005** WIQL query strings in `query_work_items` MUST be validated to reject any DDL-like or injected substrings before execution.

**SEC-006** The HTTP/SSE transport MUST support TLS (configurable cert/key path or auto-provisioned via `LETSENCRYPT_DOMAIN`).

**SEC-007** The HTTP/SSE transport MUST support an optional bearer token (`MCP_AUTH_TOKEN`) for authenticating MCP client connections.

**SEC-008** All dependency versions MUST be pinned in `package-lock.json` and audited via `npm audit` in CI (fail on high/critical).

**SEC-009** Docker images MUST run as a non-root user (`node`, UID 1001) and use a distroless or slim base image.

**SEC-010** The server MUST not expose any Azure DevOps API response data beyond what is explicitly mapped in each tool's output contract.

---

## 13. Configuration & Environment

### 13.1 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_DEVOPS_ORG_URL` | ✅ | — | `https://dev.azure.com/{org}` |
| `AZURE_DEVOPS_PAT` | ⚠️ | — | Personal Access Token (or use MSAL) |
| `AZURE_DEVOPS_DEFAULT_PROJECT` | ❌ | — | Default project if not specified in tool call |
| `AZURE_CLIENT_ID` | ⚠️ | — | Azure AD app client ID (MSAL auth) |
| `AZURE_CLIENT_SECRET` | ⚠️ | — | Azure AD app client secret |
| `AZURE_TENANT_ID` | ⚠️ | — | Azure AD tenant ID |
| `AZURE_KEYVAULT_URI` | ❌ | — | Key Vault URI for secret loading |
| `MCP_TRANSPORT` | ❌ | `stdio` | `stdio` or `http` |
| `MCP_HTTP_PORT` | ❌ | `3000` | Port for HTTP/SSE transport |
| `MCP_HTTP_HOST` | ❌ | `0.0.0.0` | Bind address for HTTP transport |
| `MCP_AUTH_TOKEN` | ❌ | — | Bearer token for HTTP client auth |
| `MCP_TLS_CERT` | ❌ | — | Path to TLS cert (HTTP transport) |
| `MCP_TLS_KEY` | ❌ | — | Path to TLS key (HTTP transport) |
| `LOG_LEVEL` | ❌ | `info` | Logging verbosity |
| `REQUEST_TIMEOUT_MS` | ❌ | `10000` | Single-item request timeout |
| `BULK_REQUEST_TIMEOUT_MS` | ❌ | `30000` | Bulk/query request timeout |
| `MAX_RETRY_ATTEMPTS` | ❌ | `3` | Max retries on 429/5xx |
| `NODE_ENV` | ❌ | `production` | `development`, `test`, `production` |

### 13.2 Configuration File (Optional)

The server MUST support loading configuration from a `mcp-config.json` file with the same keys as the environment variables (camelCase). Environment variables take precedence over the config file.

---

## 14. Project Structure

```
azure-devops-mcp/
├── src/
│   ├── index.ts                  # Entry point; transport selection
│   ├── server.ts                 # MCP server setup and tool registration
│   ├── config/
│   │   ├── index.ts              # Config loader (env + file + Key Vault)
│   │   └── schema.ts             # Zod schema for config validation
│   ├── auth/
│   │   ├── patProvider.ts        # PAT credential provider
│   │   └── azureIdentityProvider.ts  # MSAL / Managed Identity
│   ├── client/
│   │   ├── azureDevOpsClient.ts  # Wrapper around azure-devops-node-api
│   │   └── retryMiddleware.ts    # Retry + circuit breaker
│   ├── tools/
│   │   ├── index.ts              # Tool registry
│   │   ├── getWorkItem.ts
│   │   ├── getWorkItems.ts
│   │   ├── listWorkItems.ts
│   │   ├── queryWorkItems.ts
│   │   ├── createWorkItem.ts
│   │   ├── updateWorkItem.ts
│   │   ├── bulkUpdateWorkItems.ts
│   │   ├── deleteWorkItem.ts
│   │   ├── getComments.ts
│   │   ├── addComment.ts
│   │   ├── getRelations.ts
│   │   ├── addRelation.ts
│   │   ├── removeRelation.ts
│   │   ├── listProjects.ts
│   │   ├── listWorkItemTypes.ts
│   │   ├── listIterations.ts
│   │   └── listAreaPaths.ts
│   ├── resources/
│   │   └── workItemResource.ts   # MCP resource handlers
│   ├── prompts/
│   │   └── templates.ts          # Built-in MCP prompts
│   ├── services/
│   │   ├── workItemService.ts
│   │   ├── queryService.ts
│   │   ├── commentService.ts
│   │   └── metadataService.ts
│   ├── mappers/
│   │   └── workItemMapper.ts     # Azure API → MCP response shape
│   ├── transport/
│   │   ├── stdio.ts
│   │   └── http.ts               # HTTP/SSE transport with health endpoints
│   ├── observability/
│   │   ├── logger.ts             # Pino logger factory
│   │   └── metrics.ts            # Prometheus metrics registry
│   └── errors/
│       ├── McpError.ts
│       └── errorHandler.ts
├── tests/
│   ├── unit/
│   │   ├── tools/
│   │   ├── services/
│   │   └── mappers/
│   ├── integration/
│   │   └── azureDevOps.integration.test.ts
│   └── e2e/
│       └── mcp.e2e.test.ts
├── scripts/
│   ├── generate-types.ts         # Generate types from Azure DevOps OpenAPI spec
│   └── smoke-test.ts             # Post-deploy smoke test
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── publish.yml
├── docs/
│   ├── getting-started.md
│   ├── authentication.md
│   ├── tools-reference.md
│   └── deployment.md
├── .env.example
├── .eslintrc.json
├── .prettierrc
├── tsconfig.json
├── tsconfig.build.json
├── package.json
├── vitest.config.ts
└── README.md
```

---

## 15. Development Standards

### 15.1 TypeScript

- Strict mode enabled (`strict: true` in tsconfig)
- No `any` types (ESLint rule: `@typescript-eslint/no-explicit-any: error`)
- All public function signatures MUST have explicit return types
- Use Zod for all external input parsing; infer TypeScript types from Zod schemas

### 15.2 Code Style

- 2-space indentation, single quotes, trailing commas (Prettier defaults)
- All files MUST pass ESLint with zero errors and zero warnings before merge
- Maximum function length: 60 lines (excluding JSDoc)
- Prefer named exports over default exports (except entry points)

### 15.3 Git Conventions

- Branch naming: `feat/`, `fix/`, `chore/`, `docs/`
- Commit messages: Conventional Commits (e.g., `feat(tools): add bulk_update_work_items`)
- All PRs require at least one reviewer approval
- Squash merge to main

### 15.4 Dependency Management

- No dependencies with known high/critical CVEs
- Prefer `@azure` and `@modelcontextprotocol` official packages over community alternatives
- Review and update dependencies monthly

---

## 16. Testing Strategy

### 16.1 Unit Tests

- **Target:** All service, mapper, and tool handler functions
- **Framework:** Vitest
- **Mocking:** `vi.mock()` for Azure DevOps client; no network calls
- **Coverage threshold:** 85% lines, 80% branches

### 16.2 Integration Tests

- **Target:** Azure DevOps client + service layer against a dedicated test organization
- **Gating:** Run on CI with `AZURE_DEVOPS_TEST_PAT` secret
- **Isolation:** Each test run creates work items with a unique `[TEST-<run-id>]` tag and cleans them up in `afterAll`

### 16.3 End-to-End Tests

- **Target:** Full MCP protocol over stdio transport
- **Tooling:** `@modelcontextprotocol/sdk` test client
- **Scope:** Happy-path for each tool plus common error scenarios

### 16.4 Contract Tests

- **Target:** MCP tool input schemas vs. actual Azure DevOps field constraints
- **Method:** Automated via `scripts/generate-types.ts` — fail CI if generated types diverge from committed types

### 16.5 Performance Tests

- **Target:** p95 latency targets defined in Section 6.1
- **Tooling:** `autocannon` or `k6` against HTTP transport
- **Frequency:** Run weekly or before major releases

---

## 17. CI/CD Pipeline

### 17.1 Pull Request Checks (`ci.yml`)

```
PR Opened/Updated
      │
      ├── lint (eslint + prettier --check)
      ├── typecheck (tsc --noEmit)
      ├── unit tests (vitest --coverage)
      ├── audit (npm audit --audit-level=high)
      ├── build (tsup)
      └── integration tests (conditional on secrets)
```

All checks MUST pass before merge.

### 17.2 Publish Pipeline (`publish.yml`)

Triggered on tag push matching `v*.*.*`:

```
Tag pushed (v1.2.3)
      │
      ├── Run full test suite (unit + integration)
      ├── Build distributable (tsup → dist/)
      ├── Publish to npm (npm publish --provenance)
      ├── Build Docker image (multi-arch: amd64, arm64)
      ├── Push Docker image to GHCR and Docker Hub
      └── Create GitHub Release with changelog
```

### 17.3 Release Versioning

Semantic versioning (MAJOR.MINOR.PATCH) following:
- MAJOR: Breaking changes to MCP tool names or input schemas
- MINOR: New tools, new optional parameters
- PATCH: Bug fixes, performance improvements, dependency updates

---

## 18. Deployment & Distribution

### 18.1 npm Package

```
Package name:   @your-org/azure-devops-mcp
Exports:        bin (CLI entry point for stdio), CommonJS + ESM builds
Peer deps:      none
Engine:         node >= 20.0.0
```

### 18.2 Claude Desktop Configuration

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "npx",
      "args": ["-y", "@your-org/azure-devops-mcp"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/your-org",
        "AZURE_DEVOPS_PAT": "<your-pat>"
      }
    }
  }
}
```

### 18.3 Docker

```dockerfile
# docker/Dockerfile (example target)
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=build /app /app
USER 1001
EXPOSE 3000
CMD ["dist/index.js"]
```

### 18.4 Kubernetes / Helm (Optional, v1.1)

A Helm chart will be provided in `charts/azure-devops-mcp` with values for replicas, resource limits, HPA, and secret references via External Secrets Operator.

---

## 19. Documentation Requirements

**DOC-001** `README.md` MUST include: overview, quick start (< 5 min to first successful tool call), full tool reference table, configuration reference, and contributing guide.

**DOC-002** Each tool MUST have inline JSDoc on the handler function describing parameters and return shape.

**DOC-003** `docs/authentication.md` MUST cover all four auth methods with step-by-step setup instructions.

**DOC-004** `docs/tools-reference.md` MUST be auto-generated from Zod schemas via a `npm run docs:generate` script.

**DOC-005** A `CHANGELOG.md` MUST be maintained using Conventional Commits / `changesets`.

**DOC-006** All error codes defined in Section 8.1 MUST be documented in `docs/errors.md` with description and remediation steps.

---

## 20. Acceptance Criteria

| ID | Criterion | Verification Method |
|----|-----------|---------------------|
| AC-001 | All 18 tools defined in Section 5 are available via `tools/list` | Unit test + MCP client inspect |
| AC-002 | p95 single-item read < 500 ms under normal network conditions | Performance test |
| AC-003 | Retry logic fires on 429 and backs off correctly | Unit test with mock HTTP |
| AC-004 | Circuit breaker opens after 5 consecutive Azure failures | Unit test |
| AC-005 | PAT never appears in log output at any level | Log audit test |
| AC-006 | `npm audit` returns 0 high/critical findings | CI gate |
| AC-007 | `tsc --noEmit` passes with 0 errors | CI gate |
| AC-008 | Unit test coverage ≥ 85% lines | CI coverage report |
| AC-009 | `/health` returns 200 within 100 ms | Integration test |
| AC-010 | Works end-to-end with Claude Desktop (stdio) | Manual QA |
| AC-011 | Works end-to-end over HTTP/SSE transport | E2E test |
| AC-012 | Docker image runs as non-root UID 1001 | Container inspect |
| AC-013 | Managed Identity auth works on Azure-hosted deployment | Staging environment test |
| AC-014 | `delete_work_item` without `confirm: true` returns error | Unit test |
| AC-015 | Optimistic concurrency conflict returns `CONFLICT` error | Integration test |

---

## 21. Milestones & Timeline

| Milestone | Deliverables | Target |
|-----------|-------------|--------|
| M0 — Foundation | Repo scaffold, CI pipeline, auth layer, config loader | Week 1 |
| M1 — Core Read Tools | FR-001 – FR-007 (read, query, list) | Week 2 |
| M2 — Write Tools | FR-008 – FR-016 (create, update, delete, bulk) | Week 3 |
| M3 — Relations & Comments | FR-017 – FR-021 | Week 4 |
| M4 — Metadata & MCP Resources | FR-022 – FR-030 | Week 5 |
| M5 — Observability & Security | OBS-001 – OBS-007, SEC-001 – SEC-010 | Week 6 |
| M6 — HTTP Transport | NFR-005, HTTP/SSE, health, metrics | Week 7 |
| M7 — Testing & Hardening | AC-001 – AC-015, docs, performance tests | Week 8 |
| M8 — Release | npm publish, Docker push, GitHub release, docs site | Week 9 |

---

## 22. Open Questions & Risks

| # | Question / Risk | Owner | Status |
|---|----------------|-------|--------|
| OQ-1 | Will the target Azure DevOps org allow Service Principal auth or only PAT? | IT Admin | Open |
| OQ-2 | Should bulk update use the Azure DevOps PATCH batch API or parallel requests? | Eng Lead | Decision needed |
| OQ-3 | Key Vault integration scope: only at startup, or live refresh on every call? | Security | Open |
| R-1 | Azure DevOps REST API rate limits (200 req/5 min per user) may be hit in bulk scenarios | Eng | Mitigate with batching and back-off |
| R-2 | MCP SDK breaking changes if Anthropic updates the spec | Eng | Pin SDK version; subscribe to releases |
| R-3 | On-premises Azure DevOps Server TLS cert handling may require custom CA trust | DevOps | Investigate `NODE_EXTRA_CA_CERTS` |

---

## 23. Appendix

### A. Azure DevOps Work Item Fields Reference

| Reference Name | Friendly Name | Type |
|----------------|--------------|------|
| `System.Id` | ID | Integer |
| `System.Title` | Title | String |
| `System.WorkItemType` | Work Item Type | String |
| `System.State` | State | String |
| `System.AssignedTo` | Assigned To | Identity |
| `System.AreaPath` | Area Path | TreePath |
| `System.IterationPath` | Iteration Path | TreePath |
| `System.Description` | Description | HTML |
| `System.Tags` | Tags | PlainText |
| `System.CreatedDate` | Created Date | DateTime |
| `System.ChangedDate` | Changed Date | DateTime |
| `System.Rev` | Revision | Integer |
| `Microsoft.VSTS.Common.Priority` | Priority | Integer (1–4) |
| `Microsoft.VSTS.Common.Severity` | Severity | String |
| `Microsoft.VSTS.Scheduling.StoryPoints` | Story Points | Double |
| `Microsoft.VSTS.Common.AcceptanceCriteria` | Acceptance Criteria | HTML |

### B. Relevant Standards & References

- [MCP Specification](https://modelcontextprotocol.io/specification)
- [Azure DevOps Work Items REST API v7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/)
- [azure-devops-node-api](https://github.com/microsoft/azure-devops-node-api)
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [@azure/identity](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/identity/identity)
- [OWASP Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)

### C. Glossary

| Term | Definition |
|------|-----------|
| MCP | Model Context Protocol — open standard for AI-tool integration |
| PAT | Personal Access Token — Azure DevOps auth credential |
| WIQL | Work Item Query Language — SQL-like query language for Azure DevOps |
| SSE | Server-Sent Events — HTTP streaming protocol used by MCP HTTP transport |
| MSAL | Microsoft Authentication Library — Azure AD auth library |
| MI | Managed Identity — Azure-native credential for hosted services |
| CI/CD | Continuous Integration / Continuous Deployment |
| DXA | Document eXtended Attribute unit (1 inch = 1440 DXA) |

---

*Document maintained by Platform Engineering. Raise issues or PRs at `github.com/your-org/azure-devops-mcp`.*
