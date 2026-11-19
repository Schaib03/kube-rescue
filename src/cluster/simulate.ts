import { lookupImage } from "./images";
import type { Cluster, Container, Deployment, KEvent, PodTemplate, PodView, Service } from "./types";

export const TRANSITION_MS = 1500;
const SYSTEM_RESERVED_CPU = 250;
const SYSTEM_RESERVED_MEMORY = 512;
const NAME_ALPHABET = "bcdfghjklmnpqrstvwxz2456789";

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function token(seed: string, length: number): string {
  let value = hash(seed);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += NAME_ALPHABET[value % NAME_ALPHABET.length];
    value = hash(`${value}:${i}`);
  }
  return out;
}

export function templateHash(template: PodTemplate): string {
  return token(JSON.stringify(template), 10);
}

export function matches(selector: Record<string, string>, labels: Record<string, string>) {
  const keys = Object.keys(selector);
  return keys.length > 0 && keys.every((key) => labels[key] === selector[key]);
}

function secondsSince(cluster: Cluster, deployment: Deployment, now: number): number {
  if (deployment.updatedAt > 0) return (now - deployment.updatedAt) / 1000;
  return cluster.ageMinutes * 60 + (now - cluster.startedAt) / 1000;
}

function schedulableNode(cluster: Cluster, container: Container): string | null {
  const cpu = container.requests.cpu ?? 0;
  const memory = container.requests.memory ?? 0;
  const node = cluster.nodes.find(
    (n) => cpu <= n.cpu - SYSTEM_RESERVED_CPU && memory <= n.memory - SYSTEM_RESERVED_MEMORY,
  );
  return node ? node.name : null;
}

function insufficientMessage(cluster: Cluster, container: Container): string {
  const reasons: string[] = [];
  const count = cluster.nodes.length;
  if (cluster.nodes.every((n) => (container.requests.cpu ?? 0) > n.cpu - SYSTEM_RESERVED_CPU)) {
    reasons.push(`${count} Insufficient cpu`);
  }
  if (
    cluster.nodes.every(
      (n) => (container.requests.memory ?? 0) > n.memory - SYSTEM_RESERVED_MEMORY,
    )
  ) {
    reasons.push(`${count} Insufficient memory`);
  }
  return (
    `0/${count} nodes are available: ${reasons.join(", ")}. ` +
    `preemption: 0/${count} nodes are available: ${count} No preemption victims found for incoming pod.`
  );
}

function missingEnv(container: Container): string | null {
  const app = lookupImage(container.image);
  if (!app) return null;
  for (const requirement of app.requiredEnv) {
    const value = container.env[requirement.name];
    if (value === undefined || value === "") {
      return `FATAL: environment variable ${requirement.name} is not set`;
    }
    const problem = requirement.check?.(value);
    if (problem) return `FATAL: ${problem}`;
  }
  return null;
}

interface PodSeed {
  deployment: Deployment;
  template: PodTemplate;
  index: number;
  ageSeconds: number;
  inTransition: boolean;
}

function buildPod(cluster: Cluster, seed: PodSeed): PodView {
  const { deployment, template, index, ageSeconds, inTransition } = seed;
  const container = template.containers[0];
  const rsHash = templateHash(template);
  const name = `${deployment.name}-${rsHash}-${token(`${rsHash}/${index}`, 5)}`;
  const app = lookupImage(container.image);
  const object = `pod/${name}`;
  const events: KEvent[] = [];
  const event = (type: KEvent["type"], reason: string, message: string, age = 30) =>
    events.push({ type, reason, object, message, ageSeconds: Math.min(age, ageSeconds) });

  const base: PodView = {
    name,
    deployment: deployment.name,
    labels: { ...template.labels, "pod-template-hash": rsHash },
    container,
    node: null,
    ip: null,
    status: "Pending",
    ready: false,
    restarts: 0,
    ageSeconds,
    logs: [],
    previousLogs: [],
    events,
    memoryUsage: 0,
    cpuUsage: 0,
  };

  const node = schedulableNode(cluster, container);
  if (!node) {
    event("Warning", "FailedScheduling", insufficientMessage(cluster, container), ageSeconds);
    return base;
  }

  const nodeIndex = cluster.nodes.findIndex((n) => n.name === node);
  base.node = node;
  base.ip = `10.244.${nodeIndex + 1}.${10 + (hash(name) % 200)}`;
  event("Normal", "Scheduled", `Successfully assigned ${cluster.namespace}/${name} to ${node}`, ageSeconds);

  if (inTransition) {
    base.status = "ContainerCreating";
    event("Normal", "Pulling", `Pulling image "${container.image}"`, 1);
    return base;
  }

  if (!app) {
    base.status = "ImagePullBackOff";
    base.waitingReason = "ImagePullBackOff";
    const failure =
      `Failed to pull image "${container.image}": rpc error: code = NotFound desc = failed to pull ` +
      `and unpack image "${container.image}": ${container.image}: not found`;
    event("Normal", "Pulling", `Pulling image "${container.image}"`);
    event("Warning", "Failed", failure);
    event("Warning", "Failed", "Error: ErrImagePull");
    event("Normal", "BackOff", `Back-off pulling image "${container.image}"`, 10);
    event("Warning", "Failed", "Error: ImagePullBackOff", 10);
    return base;
  }

  event("Normal", "Pulled", `Container image "${container.image}" already present on machine`);
  event("Normal", "Created", `Created container ${container.name}`);
  event("Normal", "Started", `Started container ${container.name}`);

  const crashLoop = (reason: string, exitCode: number, previousLogs: string[]) => {
    base.status = "CrashLoopBackOff";
    base.waitingReason = "CrashLoopBackOff";
    base.restarts = Math.min(1 + Math.floor(ageSeconds / 45), 12);
    base.lastTermination = { reason, exitCode };
    base.previousLogs = previousLogs;
    base.logs = previousLogs;
    event(
      "Warning",
      "BackOff",
      `Back-off restarting failed container ${container.name} in pod ${name}_${cluster.namespace}`,
      15,
    );
    return base;
  };

  const envProblem = missingEnv(container);
  if (envProblem) {
    return crashLoop("Error", 1, [...app.startup, envProblem]);
  }

  const memoryLimit = container.limits.memory;
  if (memoryLimit !== undefined && memoryLimit < app.memory) {
    const loaded = Math.max(memoryLimit - 6, 1);
    const result = crashLoop("OOMKilled", 137, [
      ...app.startup,
      `catalogue: loaded 28150 products (${loaded}Mi)`,
      "catalogue: loading prices...",
    ]);
    result.logs = app.startup.slice(0, 1);
    result.memoryUsage = loaded;
    return result;
  }

  base.status = "Running";
  base.memoryUsage = Math.min(app.memory, memoryLimit ?? app.memory);
  base.cpuUsage = app.cpu;
  base.logs = [...app.startup];

  const probe = container.readinessProbe;
  if (!probe) {
    base.ready = true;
    return base;
  }
  if (probe.port !== app.port) {
    event(
      "Warning",
      "Unhealthy",
      `Readiness probe failed: Get "http://${base.ip}:${probe.port}${probe.path}": ` +
        `dial tcp ${base.ip}:${probe.port}: connect: connection refused`,
      5,
    );
    return base;
  }
  if (probe.path !== app.healthPath) {
    base.logs.push(`GET ${probe.path} 404 0.4ms`, `GET ${probe.path} 404 0.3ms`);
    event("Warning", "Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 404", 5);
    return base;
  }
  base.logs.push(`GET ${probe.path} 200 0.3ms`);
  base.ready = true;
  return base;
}

function isHealthyTemplate(template: PodTemplate): boolean {
  const container = template.containers[0];
  const app = lookupImage(container.image);
  if (!app || missingEnv(container)) return false;
  return container.limits.memory === undefined || container.limits.memory >= app.memory;
}

export function podsFor(cluster: Cluster, deployment: Deployment, now: number): PodView[] {
  const age = secondsSince(cluster, deployment, now);
  const inTransition = deployment.updatedAt > 0 && now - deployment.updatedAt < TRANSITION_MS;
  const current: PodView[] = [];
  for (let index = 0; index < deployment.replicas; index++) {
    current.push(
      buildPod(cluster, { deployment, template: deployment.template, index, ageSeconds: age, inTransition }),
    );
  }

  // A rollout to an image that cannot be pulled stalls: the previous ReplicaSet keeps
  // serving and only one new pod (maxSurge) is created.
  const previous = deployment.history.at(-1);
  const stalled = !inTransition && !lookupImage(deployment.template.containers[0].image);
  if (stalled && previous && isHealthyTemplate(previous.template)) {
    const oldAge = cluster.ageMinutes * 60 + 1800 + (now - cluster.startedAt) / 1000;
    const old: PodView[] = [];
    for (let index = 0; index < deployment.replicas; index++) {
      old.push(
        buildPod(cluster, {
          deployment,
          template: previous.template,
          index,
          ageSeconds: oldAge,
          inTransition: false,
        }),
      );
    }
    return [...old, ...current.slice(0, 1)];
  }
  return current;
}

export function allPods(cluster: Cluster, now: number): PodView[] {
  return cluster.deployments.flatMap((d) => podsFor(cluster, d, now));
}

export function endpointsFor(cluster: Cluster, service: Service, now: number) {
  const pods = allPods(cluster, now).filter((p) => p.ip && matches(service.selector, p.labels));
  return {
    ready: pods.filter((p) => p.ready).map((p) => ({ pod: p, address: `${p.ip}:${service.targetPort}` })),
    notReady: pods.filter((p) => !p.ready).map((p) => ({ pod: p, address: `${p.ip}:${service.targetPort}` })),
  };
}

export function curl(cluster: Cluster, url: string, now: number): { ok: boolean; output: string } {
  const match = /^(?:https?:\/\/)?([a-z0-9-]+)(?:\.[a-z0-9.-]+)?(?::(\d+))?(\/\S*)?$/.exec(url);
  if (!match) return { ok: false, output: `curl: (3) URL rejected: Malformed input to a URL function` };
  const [, host, portText, path = "/"] = match;
  const service = cluster.services.find((s) => s.name === host);
  if (!service) return { ok: false, output: `curl: (6) Could not resolve host: ${host}` };
  const port = portText ? Number(portText) : 80;
  if (port !== service.port) {
    return { ok: false, output: `curl: (28) Failed to connect to ${host} port ${port} after 3001 ms: Timeout was reached` };
  }
  const { ready } = endpointsFor(cluster, service, now);
  const refused = { ok: false, output: `curl: (7) Failed to connect to ${host} port ${port} after 2 ms: Couldn't connect to server` };
  if (ready.length === 0) return refused;
  const app = lookupImage(ready[0].pod.container.image);
  if (!app || app.port !== service.targetPort) return refused;
  if (path !== "/" && path !== app.healthPath) return { ok: true, output: "404 page not found" };
  return { ok: true, output: app.response };
}
