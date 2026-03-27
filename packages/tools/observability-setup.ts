/**
 * Observability configuration factory
 * @param service - Service name
 * @param environment - Environment (dev/staging/prod)
 * @param logLevel - Logging level (info/warn/error)
 * @param metricsPort - Metrics endpoint port
 * @param tracingEndpoint - Tracing collection endpoint
 * @returns Config object with observability settings
 */
export function configure({
  service,
  environment,
  logLevel = 'info',
  metricsPort = 9464,
  tracingEndpoint
}: {
  service: string;
  environment: string;
  logLevel?: string;
  metricsPort?: number;
  tracingEndpoint: string;
}): Config {
  return { service, environment, logLevel, metricsPort, tracingEndpoint };
}

/**
 * Generate structured logging configuration
 * @param config - Observability config
 * @returns Logger configuration object
 */
export function loggerConfig(config: Config): LoggerConfig {
  return {
    level: config.logLevel,
    service: config.service,
    environment: config.environment,
    format: 'json',
    tags: ['observability']
  };
}

/**
 * Generate Prometheus metrics configuration
 * @param config - Observability config
 * @returns Metrics configuration object
 */
export function metricsConfig(config: Config): MetricsConfig {
  return {
    port: config.metricsPort,
    endpoint: `/metrics`,
    scrapeInterval: '30s',
    name: `${config.service}_metrics`
  };
}

/**
 * Generate OpenTelemetry tracing configuration
 * @param config - Observability config
 * @returns Tracing configuration object
 */
export function tracingConfig(config: Config): TracingConfig {
  return {
    endpoint: config.tracingEndpoint,
    service: config.service,
    environment: config.environment,
    samplingRate: 1.0
  };
}

/**
 * Render complete observability setup as code snippets
 * @param config - Observability config
 * @returns Code configuration object
 */
export function renderSetup(config: Config): SetupCode {
  return {
    logger: `const logger = createLogger(${JSON.stringify(loggerConfig(config))});`,
    metrics: `startMetricsServer(${JSON.stringify(metricsConfig(config))});`,
    tracing: `initializeTracer(${JSON.stringify(tracingConfig(config))});`
  };
}

// Types
interface Config {
  service: string;
  environment: string;
  logLevel: string;
  metricsPort: number;
  tracingEndpoint: string;
}

interface LoggerConfig {
  level: string;
  service: string;
  environment: string;
  format: string;
  tags: string[];
}

interface MetricsConfig {
  port: number;
  endpoint: string;
  scrapeInterval: string;
  name: string;
}

interface TracingConfig {
  endpoint: string;
  service: string;
  environment: string;
  samplingRate: number;
}

interface SetupCode {
  logger: string;
  metrics: string;
  tracing: string;
}