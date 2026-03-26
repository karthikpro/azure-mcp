import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import dotenv from 'dotenv';
import { z } from 'zod';

import { McpError } from './errors.js';
import { compactObject } from './utils.js';

dotenv.config();

const configSchema = z.object({
  azureDevopsOrgUrl: z.string().url(),
  azureDevopsPat: z.string().min(1).optional(),
  azureDevopsDefaultProject: z.string().min(1).optional(),
  azureAuthMode: z.enum(['interactive', 'default']).default('interactive'),
  azureAuthRecordPath: z.string().min(1).optional(),
  azureClientId: z.string().min(1).optional(),
  azureClientSecret: z.string().min(1).optional(),
  azureTenantId: z.string().min(1).optional(),
  azureKeyvaultUri: z.string().url().optional(),
  mcpTransport: z.enum(['stdio', 'http']).default('stdio'),
  mcpHttpPort: z.coerce.number().int().positive().default(3000),
  mcpHttpHost: z.string().default('0.0.0.0'),
  mcpAuthToken: z.string().min(1).optional(),
  mcpTlsCert: z.string().min(1).optional(),
  mcpTlsKey: z.string().min(1).optional(),
  logLevel: z.string().default('info'),
  requestTimeoutMs: z.coerce.number().int().positive().default(10000),
  bulkRequestTimeoutMs: z.coerce.number().int().positive().default(30000),
  maxRetryAttempts: z.coerce.number().int().min(0).max(5).default(3),
  nodeEnv: z.enum(['development', 'test', 'production']).default('production'),
});

type RawConfig = z.input<typeof configSchema>;
export type AppConfig = z.infer<typeof configSchema>;

const secretCache = new Map<string, { value: string; expiresAt: number }>();

const loadConfigFile = async (): Promise<Partial<RawConfig>> => {
  const configPath = path.join(process.cwd(), 'mcp-config.json');

  try {
    const content = await readFile(configPath, 'utf8');
    return JSON.parse(content) as Partial<RawConfig>;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return {};
    }

    throw new McpError('VALIDATION_ERROR', 'Unable to read mcp-config.json.', {
      cause: error,
    });
  }
};

const readKeyVaultSecret = async (
  vaultUri: string,
  secretName: string,
): Promise<string | undefined> => {
  const cacheKey = `${vaultUri}:${secretName}`;
  const cached = secretCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const client = new SecretClient(vaultUri, new DefaultAzureCredential());

  try {
    const secret = await client.getSecret(secretName);
    const value = secret.value;
    if (!value) {
      return undefined;
    }

    secretCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return value;
  } catch {
    return undefined;
  }
};

const loadKeyVaultSecrets = async (
  baseConfig: Partial<RawConfig>,
): Promise<Partial<RawConfig>> => {
  if (!baseConfig.azureKeyvaultUri) {
    return {};
  }

  const [pat, authToken] = await Promise.all([
    readKeyVaultSecret(baseConfig.azureKeyvaultUri, 'AZURE_DEVOPS_PAT'),
    readKeyVaultSecret(baseConfig.azureKeyvaultUri, 'MCP_AUTH_TOKEN'),
  ]);

  return {
    azureDevopsPat: pat,
    mcpAuthToken: authToken,
  };
};

export const loadConfig = async (): Promise<AppConfig> => {
  const fileConfig = await loadConfigFile();
  const envConfig = compactObject({
    azureDevopsOrgUrl: process.env.AZURE_DEVOPS_ORG_URL,
    azureDevopsPat: process.env.AZURE_DEVOPS_PAT,
    azureDevopsDefaultProject: process.env.AZURE_DEVOPS_DEFAULT_PROJECT,
    azureAuthMode: process.env.AZURE_AUTH_MODE as RawConfig['azureAuthMode'],
    azureAuthRecordPath: process.env.AZURE_AUTH_RECORD_PATH,
    azureClientId: process.env.AZURE_CLIENT_ID,
    azureClientSecret: process.env.AZURE_CLIENT_SECRET,
    azureTenantId: process.env.AZURE_TENANT_ID,
    azureKeyvaultUri: process.env.AZURE_KEYVAULT_URI,
    mcpTransport: process.env.MCP_TRANSPORT as RawConfig['mcpTransport'],
    mcpHttpPort: process.env.MCP_HTTP_PORT,
    mcpHttpHost: process.env.MCP_HTTP_HOST,
    mcpAuthToken: process.env.MCP_AUTH_TOKEN,
    mcpTlsCert: process.env.MCP_TLS_CERT,
    mcpTlsKey: process.env.MCP_TLS_KEY,
    logLevel: process.env.LOG_LEVEL,
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS,
    bulkRequestTimeoutMs: process.env.BULK_REQUEST_TIMEOUT_MS,
    maxRetryAttempts: process.env.MAX_RETRY_ATTEMPTS,
    nodeEnv: process.env.NODE_ENV as RawConfig['nodeEnv'],
  });

  const merged = {
    ...fileConfig,
    ...envConfig,
  };

  const keyVaultConfig = await loadKeyVaultSecrets(merged);

  return configSchema.parse({
    ...fileConfig,
    ...keyVaultConfig,
    ...envConfig,
  });
};
