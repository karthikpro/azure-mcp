# Azure DevOps MCP Server

Azure DevOps MCP server for reading and updating work items, comments, metadata, and relations from an MCP-compatible client.

## Features

- Read one or many work items by ID
- Query work items with raw WIQL
- List work items with structured filters such as type, state, assignee, tags, iteration, and area path
- Create, update, bulk update, and delete work items
- Read and add work item comments
- Read, add, and remove work item relations
- List projects, work item types, iterations, and area paths
- Expose reusable prompts for sprint summaries, bug triage, and drafting work items
- Expose MCP resources for server info and individual work items
- Support `stdio` and HTTP transport modes
- Support interactive Azure sign-in with persistent token caching
- Support PAT-based auth and Azure Key Vault backed secret loading

## Requirements

- Node.js 20 or newer
- Access to an Azure DevOps organization and project
- An MCP client that supports a JSON server configuration

## Install

```bash
npm install
npm run build
```

## Authentication

The server supports these authentication modes:

- `interactive`: opens the Microsoft sign-in flow on first use, then reuses the cached session on later runs
- `default`: uses the Azure default credential chain
- `AZURE_DEVOPS_PAT`: uses a personal access token if you prefer PAT-based auth

For interactive auth, the server stores:

- an authentication record at `~/.azure-devops-mcp/authentication-record.json`
- a persistent token cache managed by the operating system

## Configuration

The server reads configuration from:

- environment variables
- an optional `mcp-config.json` file in the project root

If both are present, environment variables take precedence.

### Common settings

| Setting | Description |
| --- | --- |
| `AZURE_DEVOPS_ORG_URL` | Azure DevOps organization URL |
| `AZURE_DEVOPS_DEFAULT_PROJECT` | Default project used when a tool call omits `project` |
| `AZURE_AUTH_MODE` | `interactive` or `default` |
| `AZURE_AUTH_RECORD_PATH` | Optional custom path for the auth record file |
| `AZURE_DEVOPS_PAT` | Optional PAT for direct Azure DevOps auth |
| `AZURE_CLIENT_ID` | Optional Entra app client ID |
| `AZURE_TENANT_ID` | Optional Entra tenant ID |
| `AZURE_CLIENT_SECRET` | Optional client secret for non-interactive Azure auth |
| `AZURE_KEYVAULT_URI` | Optional Key Vault URI for loading secrets |
| `MCP_TRANSPORT` | `stdio` or `http` |
| `MCP_HTTP_HOST` | HTTP bind host when using HTTP transport |
| `MCP_HTTP_PORT` | HTTP port when using HTTP transport |
| `MCP_AUTH_TOKEN` | Optional bearer token for the HTTP `/mcp` endpoint |
| `MCP_TLS_CERT` | Optional TLS certificate secret or path value |
| `MCP_TLS_KEY` | Optional TLS private key secret or path value |
| `LOG_LEVEL` | Log level such as `info` or `debug` |
| `REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds |
| `BULK_REQUEST_TIMEOUT_MS` | Timeout for bulk requests in milliseconds |
| `MAX_RETRY_ATTEMPTS` | Retry count for transient failures |

### Example `mcp-config.json`

```json
{
  "azureDevopsOrgUrl": "https://dev.azure.com/example-org",
  "azureDevopsDefaultProject": "example-project",
  "azureAuthMode": "interactive",
  "mcpTransport": "stdio",
  "logLevel": "info",
  "requestTimeoutMs": 10000,
  "bulkRequestTimeoutMs": 30000,
  "maxRetryAttempts": 3
}
```

## MCP Client JSON Config

### Stdio example

Use this when your MCP client launches the server as a local process.

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "node",
      "args": [
        "F:/path/to/azure-mcp/dist/index.js"
      ],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/example-org",
        "AZURE_DEVOPS_DEFAULT_PROJECT": "example-project",
        "AZURE_AUTH_MODE": "interactive",
        "MCP_TRANSPORT": "stdio",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### HTTP example

Use this when you want to run the server separately and expose `/mcp` over HTTP.

Server environment:

```json
{
  "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/example-org",
  "AZURE_DEVOPS_DEFAULT_PROJECT": "example-project",
  "AZURE_AUTH_MODE": "interactive",
  "MCP_TRANSPORT": "http",
  "MCP_HTTP_HOST": "127.0.0.1",
  "MCP_HTTP_PORT": "3000",
  "MCP_AUTH_TOKEN": "replace-with-a-demo-token"
}
```

Client connection example:

```json
{
  "mcpServers": {
    "azure-devops-http": {
      "transport": {
        "type": "streamable-http",
        "url": "http://127.0.0.1:3000/mcp",
        "headers": {
          "Authorization": "Bearer replace-with-a-demo-token"
        }
      }
    }
  }
}
```

## Available Tools

- `get_work_item`
- `get_work_items`
- `query_work_items`
- `list_work_items`
- `create_work_item`
- `update_work_item`
- `bulk_update_work_items`
- `delete_work_item`
- `get_comments`
- `add_comment`
- `get_relations`
- `add_relation`
- `remove_relation`
- `list_projects`
- `list_work_item_types`
- `list_iterations`
- `list_area_paths`

## Available Prompts

- `summarize_sprint`
- `triage_bugs`
- `draft_work_item`

## Available Resources

- `azure-devops://server/info`
- `azure-devops://{organization}/{project}/workitems/{id}`

## Run

Development mode:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```
