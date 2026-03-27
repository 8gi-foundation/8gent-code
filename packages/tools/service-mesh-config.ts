/**
 * Builds a traffic policy configuration.
 * @param service - Service name
 * @param retries - Number of retries
 * @param timeout - Timeout in seconds
 * @param circuitBreaker - Circuit breaker settings
 * @returns Traffic policy config
 */
export function trafficPolicy({ service, retries, timeout, circuitBreaker }: { service: string, retries: number, timeout: number, circuitBreaker: { maxRetries: number, timeout: number } }): { service: string, retries: number, timeout: number, circuitBreaker: { maxRetries: number, timeout: number } } {
  return { service, retries, timeout, circuitBreaker };
}

/**
 * Creates virtual service routing rules.
 * @param host - Hostname
 * @param routes - Array of route configurations
 * @param timeout - Timeout in seconds
 * @returns Virtual service config
 */
export function virtualService({ host, routes, timeout }: { host: string, routes: { from: string, to: string }[], timeout: number }): { host: string, routes: { from: string, to: string }[], timeout: number } {
  return { host, routes, timeout };
}

/**
 * Generates Istio-compatible destination rule.
 * @param host - Hostname
 * @param trafficPolicy - Traffic policy configuration
 * @param subsets - Array of subsets
 * @returns Destination rule config
 */
export function destinationRule({ host, trafficPolicy, subsets }: { host: string, trafficPolicy: { service: string, retries: number, timeout: number, circuitBreaker: { maxRetries: number, timeout: number } }, subsets: { name: string, labels: { version: string } }[] }): { host: string, trafficPolicy: { service: string, retries: number, timeout: number, circuitBreaker: { maxRetries: number, timeout: number } }, subsets: { name: string, labels: { version: string } }[] } {
  return { host, trafficPolicy, subsets };
}

/**
 * Renders configuration as YAML manifest.
 * @param config - Configuration object containing virtualService and destinationRule
 * @returns Formatted YAML string
 */
export function renderYAML(config: { virtualService: { host: string, routes: { from: string, to: string }[], timeout: number }, destinationRule: { host: string, trafficPolicy: { service: string, retries: number, timeout: number, circuitBreaker: { maxRetries: number, timeout: number } }, subsets: { name: string, labels: { version: string } }[] } }): string {
  return `apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: ${config.virtualService.host}
spec:
  hosts:
    - ${config.virtualService.host}
  http:
    - route:
        - destination:
            host: ${config.virtualService.routes[0].to}
      timeout: ${config.virtualService.timeout}s
---
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: ${config.destinationRule.host}
spec:
  host: ${config.destinationRule.host}
  trafficPolicy:
    retries:
      attempts: ${config.destinationRule.trafficPolicy.retries}
    timeout: ${config.destinationRule.trafficPolicy.timeout}s
    circuitBreaker:
      maxRetries: ${config.destinationRule.trafficPolicy.circuitBreaker.maxRetries}
      timeout: ${config.destinationRule.trafficPolicy.circuitBreaker.timeout}s
  subsets:
    ${config.destinationRule.subsets.map(sub => `    - name: ${sub.name}\n      labels:\n        version: ${sub.labels.version}`).join('\n')}
`;
}