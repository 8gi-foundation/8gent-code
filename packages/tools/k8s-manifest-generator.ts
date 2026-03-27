/**
 * Generates Kubernetes Deployment YAML
 * @param name - Deployment name
 * @param image - Container image
 * @param replicas - Number of replicas
 * @param port - Container port
 * @param env - Environment variables as key-value object
 * @returns YAML string for Deployment
 */
export function deployment({ name, image, replicas, port, env = {} }: { name: string; image: string; replicas: number; port: number; env?: Record<string, string> }): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: ${name}
          image: ${image}
          ports:
            - containerPort: ${port}
          env:
            ${Object.entries(env).map(([k, v]) => `            - name: ${k}\n              value: ${v}`).join('\n')}
`;
}

/**
 * Generates Kubernetes Service YAML
 * @param name - Service name
 * @param selector - Selector labels
 * @param port - Service port
 * @param type - Service type (ClusterIP/NodePort/LoadBalancer)
 * @returns YAML string for Service
 */
export function service({ name, selector, port, type = 'ClusterIP' }: { name: string; selector: Record<string, string>; port: number; type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer' }): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  type: ${type}
  selector:
    ${Object.entries(selector).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
  ports:
    - port: ${port}
      targetPort: ${port}
`;
}

/**
 * Generates Kubernetes ConfigMap YAML
 * @param name - ConfigMap name
 * @param data - Key-value data
 * @returns YAML string for ConfigMap
 */
export function configmap({ name, data }: { name: string; data: Record<string, string> }): string {
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}
data:
  ${Object.entries(data).map(([k, v]) => `  ${k}: ${v}`).join('\n')}
`;
}

/**
 * Generates Kubernetes Ingress YAML
 * @param name - Ingress name
 * @param host - Hostname
 * @param serviceName - Target service name
 * @param port - Target service port
 * @returns YAML string for Ingress
 */
export function ingress({ name, host, serviceName, port }: { name: string; host: string; serviceName: string; port: number }): string {
  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
spec:
  rules:
    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${serviceName}
                port:
                  number: ${port}
`;
}

/**
 * Generates Kubernetes HPA YAML
 * @param name - HPA name
 * @param targetRef - Target resource reference
 * @param minReplicas - Minimum replicas
 * @param maxReplicas - Maximum replicas
 * @param cpuPercent - CPU utilization percentage
 * @returns YAML string for HPA
 */
export function hpa({ name, targetRef, minReplicas, maxReplicas, cpuPercent }: { name: string; targetRef: { apiVersion: string; kind: string; name: string }; minReplicas: number; maxReplicas: number; cpuPercent: number }): string {
  return `apiVersion: autoscaling/v2beta2
kind: HorizontalPodAutoscaler
metadata:
  name: ${name}
spec:
  scaleTargetRef:
    apiVersion: ${targetRef.apiVersion}
    kind: ${targetRef.kind}
    name: ${targetRef.name}
  minReplicas: ${minReplicas}
  maxReplicas: ${maxReplicas}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: ${cpuPercent}
`;
}