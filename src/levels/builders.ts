import { allPods, curl, podsFor } from "../cluster/simulate";
import type { Cluster, Container, Deployment, PodTemplate, Service } from "../cluster/types";

export function container(name: string, image: string, extra: Partial<Container> = {}): Container {
  return {
    name,
    image,
    env: {},
    containerPort: 8080,
    requests: { cpu: 50, memory: 64 },
    limits: {},
    ...extra,
  };
}

export function deployment(
  name: string,
  c: Container,
  options: { replicas?: number; labels?: Record<string, string>; history?: PodTemplate[] } = {},
): Deployment {
  const labels = options.labels ?? { app: name };
  const history = (options.history ?? []).map((template, i) => ({
    revision: i + 1,
    template,
    cause: i === 0 ? "" : "kubectl apply",
  }));
  return {
    name,
    replicas: options.replicas ?? 1,
    selector: { app: labels.app },
    template: { labels, containers: [c] },
    revision: history.length + 1,
    history,
    changeCause: "",
    updatedAt: 0,
  };
}

export function service(name: string, selector: Record<string, string>, targetPort = 8080, clusterIP?: string): Service {
  const octet = 10 + (name.length * 37) % 200;
  return { name, selector, port: 80, targetPort, clusterIP: clusterIP ?? `10.96.${octet}.${(octet * 7) % 250}` };
}

export function toolbox(): Deployment {
  return deployment(
    "toolbox",
    container("toolbox", "busybox:1.37", { containerPort: undefined, requests: { cpu: 10, memory: 16 } }),
  );
}

export function cluster(now: number, deployments: Deployment[], services: Service[]): Cluster {
  return {
    namespace: "shop",
    startedAt: now,
    ageMinutes: 25,
    deployments,
    services,
    nodes: [
      { name: "node-1", cpu: 2000, memory: 4096 },
      { name: "node-2", cpu: 2000, memory: 4096 },
    ],
    configMaps: [],
  };
}

export function healthy(c: Cluster, name: string, now: number, replicas?: number): boolean {
  const d = c.deployments.find((x) => x.name === name);
  if (!d) return false;
  const pods = podsFor(c, d, now);
  const expected = replicas ?? d.replicas;
  return d.replicas >= expected && pods.length === d.replicas && pods.every((p) => p.ready);
}

export function reachable(c: Cluster, url: string, now: number): boolean {
  return curl(c, url, now).ok;
}

export function noFailingPods(c: Cluster, now: number): boolean {
  return allPods(c, now).every((p) => p.status === "Running");
}
