import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export interface Metrics {
  registry: Registry;
  mcpToolCallsTotal: Counter<'tool' | 'status'>;
  mcpToolDurationSeconds: Histogram<'tool'>;
  azureDevopsApiCallsTotal: Counter<'operation' | 'status_code'>;
  azureDevopsApiDurationSeconds: Histogram<'operation'>;
  azureDevopsRateLimitHitsTotal: Counter;
  circuitBreakerState: Gauge;
}

export const createMetrics = (): Metrics => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const mcpToolCallsTotal = new Counter({
    name: 'mcp_tool_calls_total',
    help: 'Total tool invocations',
    labelNames: ['tool', 'status'],
    registers: [registry],
  });

  const mcpToolDurationSeconds = new Histogram({
    name: 'mcp_tool_duration_seconds',
    help: 'Tool latency',
    labelNames: ['tool'],
    registers: [registry],
  });

  const azureDevopsApiCallsTotal = new Counter({
    name: 'azure_devops_api_calls_total',
    help: 'Azure DevOps API calls',
    labelNames: ['operation', 'status_code'],
    registers: [registry],
  });

  const azureDevopsApiDurationSeconds = new Histogram({
    name: 'azure_devops_api_duration_seconds',
    help: 'Azure DevOps API latency',
    labelNames: ['operation'],
    registers: [registry],
  });

  const azureDevopsRateLimitHitsTotal = new Counter({
    name: 'azure_devops_rate_limit_hits_total',
    help: 'Azure DevOps 429 responses',
    registers: [registry],
  });

  const circuitBreakerState = new Gauge({
    name: 'circuit_breaker_state',
    help: '0=closed, 1=half-open, 2=open',
    registers: [registry],
  });

  circuitBreakerState.set(0);

  return {
    registry,
    mcpToolCallsTotal,
    mcpToolDurationSeconds,
    azureDevopsApiCallsTotal,
    azureDevopsApiDurationSeconds,
    azureDevopsRateLimitHitsTotal,
    circuitBreakerState,
  };
};
