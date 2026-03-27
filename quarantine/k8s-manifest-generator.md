# k8s-manifest-generator

Generates Kubernetes manifests: Deployment, Service, ConfigMap, Ingress, HPA.

## Requirements
- deployment({ name, image, replicas, port, env{} }): returns Deployment YAML
- service({ name, selector{}, port, type? }): returns Service YAML
- configmap({ name, data{} }): returns ConfigMap YAML
- ingress({ name, host, serviceName, port }): returns Ingress YAML
- hpa({ name, targetRef, minReplicas, maxReplicas, cpuPercent }): returns HPA YAML

## Status

Quarantine - pending review.

## Location

`packages/tools/k8s-manifest-generator.ts`
