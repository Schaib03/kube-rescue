import { formatCpu, formatMemory, parseCpu, parseMemory } from "./quantity";
import type { Container, Deployment, PodTemplate, Quantity, Service } from "./types";

type Json = Record<string, unknown>;

function quantityToJson(q: Quantity): Json | undefined {
  const out: Json = {};
  if (q.cpu !== undefined) out.cpu = formatCpu(q.cpu);
  if (q.memory !== undefined) out.memory = formatMemory(q.memory);
  return Object.keys(out).length ? out : undefined;
}

function quantityFromJson(value: unknown): Quantity {
  const q = (value ?? {}) as Json;
  return {
    cpu: q.cpu === undefined ? undefined : parseCpu(String(q.cpu)),
    memory: q.memory === undefined ? undefined : parseMemory(String(q.memory)),
  };
}

export function containerToJson(c: Container): Json {
  const resources: Json = {};
  const requests = quantityToJson(c.requests);
  const limits = quantityToJson(c.limits);
  if (requests) resources.requests = requests;
  if (limits) resources.limits = limits;
  return {
    name: c.name,
    image: c.image,
    ports: c.containerPort ? [{ containerPort: c.containerPort, protocol: "TCP" }] : undefined,
    env: Object.keys(c.env).length
      ? Object.entries(c.env).map(([name, value]) => ({ name, value }))
      : undefined,
    resources,
    readinessProbe: c.readinessProbe
      ? { httpGet: { path: c.readinessProbe.path, port: c.readinessProbe.port }, periodSeconds: 5 }
      : undefined,
  };
}

function containerFromJson(value: Json): Container {
  const env: Record<string, string> = {};
  for (const item of (value.env as Json[] | undefined) ?? []) {
    if (item.name !== undefined) env[String(item.name)] = String(item.value ?? "");
  }
  const ports = (value.ports as Json[] | undefined) ?? [];
  const resources = (value.resources ?? {}) as Json;
  const probe = (value.readinessProbe as Json | undefined)?.httpGet as Json | undefined;
  if (!value.name || !value.image) throw new Error("containers need a name and an image");
  return {
    name: String(value.name),
    image: String(value.image),
    env,
    containerPort: ports[0]?.containerPort === undefined ? undefined : Number(ports[0].containerPort),
    readinessProbe: probe ? { path: String(probe.path ?? "/"), port: Number(probe.port) } : undefined,
    requests: quantityFromJson(resources.requests),
    limits: quantityFromJson(resources.limits),
  };
}

export function deploymentToJson(d: Deployment): Json {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: d.name,
      annotations: { "deployment.kubernetes.io/revision": String(d.revision) },
    },
    spec: {
      replicas: d.replicas,
      selector: { matchLabels: { ...d.selector } },
      template: {
        metadata: { labels: { ...d.template.labels } },
        spec: { containers: d.template.containers.map(containerToJson) },
      },
    },
  };
}

export function templateFromDeploymentJson(json: Json): { replicas: number; template: PodTemplate } {
  const spec = (json.spec ?? {}) as Json;
  const template = (spec.template ?? {}) as Json;
  const metadata = (template.metadata ?? {}) as Json;
  const podSpec = (template.spec ?? {}) as Json;
  const containers = ((podSpec.containers as Json[] | undefined) ?? []).map(containerFromJson);
  if (containers.length === 0) throw new Error("spec.template.spec.containers: Required value");
  return {
    replicas: Number(spec.replicas ?? 1),
    template: { labels: { ...((metadata.labels as Record<string, string>) ?? {}) }, containers },
  };
}

export function serviceToJson(s: Service): Json {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: s.name },
    spec: {
      type: "ClusterIP",
      clusterIP: s.clusterIP,
      selector: { ...s.selector },
      ports: [{ port: s.port, targetPort: s.targetPort, protocol: "TCP" }],
    },
  };
}

export function serviceFieldsFromJson(json: Json): Pick<Service, "selector" | "port" | "targetPort"> {
  const spec = (json.spec ?? {}) as Json;
  const port = ((spec.ports as Json[] | undefined) ?? [])[0] ?? {};
  return {
    selector: Object.fromEntries(
      Object.entries((spec.selector as Json) ?? {}).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)]),
    ),
    port: Number(port.port),
    targetPort: Number(port.targetPort ?? port.port),
  };
}

const MERGE_KEYS: Record<string, string> = { containers: "name", ports: "port", env: "name" };

// Kubernetes' strategic merge patch, reduced to what this game needs: objects merge
// recursively, null deletes a key, and lists of containers, ports and env vars merge by key.
export function strategicMerge(target: unknown, patch: unknown, key = ""): unknown {
  if (Array.isArray(patch)) {
    const mergeKey = MERGE_KEYS[key];
    if (!mergeKey || !Array.isArray(target)) return patch;
    const result = target.map((item) => ({ ...(item as Json) }));
    for (const item of patch as Json[]) {
      const index = result.findIndex((existing) => existing[mergeKey] === item[mergeKey]);
      if (index >= 0) result[index] = strategicMerge(result[index], item) as Json;
      else result.push(item);
    }
    return result;
  }
  if (patch !== null && typeof patch === "object") {
    const base: Json = target !== null && typeof target === "object" && !Array.isArray(target) ? { ...(target as Json) } : {};
    for (const [k, v] of Object.entries(patch as Json)) {
      if (v === null) delete base[k];
      else base[k] = strategicMerge(base[k], v, k);
    }
    return base;
  }
  return patch;
}
