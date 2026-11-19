import {
  deploymentToJson,
  serviceFieldsFromJson,
  serviceToJson,
  strategicMerge,
  templateFromDeploymentJson,
} from "../cluster/manifest";
import { formatCpu, formatMemory, parseCpu, parseMemory } from "../cluster/quantity";
import { allPods, curl, endpointsFor, podsFor } from "../cluster/simulate";
import type { Cluster, Deployment, KEvent, PodTemplate, PodView, Service } from "../cluster/types";
import { age, table, toYaml } from "./format";
import { type ParsedArgs, parseArgs, tokenize } from "./tokenize";

export interface Result {
  output: string;
  error?: boolean;
  changed?: boolean;
}

const PATCH_BOOLEANS = new Set(["show-labels"]);

class KubectlError extends Error {}

const fail = (message: string): never => {
  throw new KubectlError(message);
};

const KINDS: Record<string, string> = {
  po: "pods", pod: "pods", pods: "pods",
  deploy: "deployments", deployment: "deployments", deployments: "deployments",
  svc: "services", service: "services", services: "services",
  ep: "endpoints", endpoints: "endpoints",
  no: "nodes", node: "nodes", nodes: "nodes",
  ev: "events", event: "events", events: "events",
  cm: "configmaps", configmap: "configmaps", configmaps: "configmaps",
  ns: "namespaces", namespace: "namespaces", namespaces: "namespaces",
  rs: "replicasets", replicaset: "replicasets", replicasets: "replicasets",
  all: "all",
};


function kindOf(word: string | undefined): string {
  if (!word) fail("error: you must specify the type of resource to get");
  const kind = KINDS[word!.toLowerCase()];
  if (!kind) fail(`error: the server doesn't have a resource type "${word}"`);
  return kind!;
}

// Accepts "deployment/web", "deploy web" and similar forms.
function target(positional: string[], index = 0): { kind: string; name: string } {
  const first = positional[index];
  if (!first) fail("error: you must specify a resource and a name");
  if (first.includes("/")) {
    const [kind, name] = first.split("/", 2);
    return { kind: kindOf(kind), name };
  }
  const name = positional[index + 1];
  if (!name) fail(`error: you must specify the name of the ${first}`);
  return { kind: kindOf(first), name: name! };
}

function notFound(kind: string, name: string): never {
  return fail(`Error from server (NotFound): ${kind} "${name}" not found`);
}

function findDeployment(cluster: Cluster, name: string): Deployment {
  return cluster.deployments.find((d) => d.name === name) ?? notFound("deployments.apps", name);
}

function findService(cluster: Cluster, name: string): Service {
  return cluster.services.find((s) => s.name === name) ?? notFound("services", name);
}

function findPod(cluster: Cluster, name: string, now: number): PodView {
  return allPods(cluster, now).find((p) => p.name === name) ?? notFound("pods", name);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function updateTemplate(d: Deployment, template: PodTemplate, cause: string, now: number): boolean {
  if (JSON.stringify(template) === JSON.stringify(d.template)) return false;
  d.history.push({ revision: d.revision, template: d.template, cause: d.changeCause });
  d.template = template;
  d.revision += 1;
  d.changeCause = cause;
  d.updatedAt = now;
  return true;
}

function serviceAge(cluster: Cluster, now: number): number {
  return cluster.ageMinutes * 60 + 1800 + (now - cluster.startedAt) / 1000;
}

function readyCount(pods: PodView[]) {
  return pods.filter((p) => p.ready).length;
}

function restartsText(p: PodView): string {
  return p.restarts > 0 ? `${p.restarts} (${Math.min(Math.round(p.ageSeconds), 40)}s ago)` : "0";
}

// ---------- get ----------

function getPods(cluster: Cluster, args: ParsedArgs, now: number, name?: string): string {
  let pods = allPods(cluster, now);
  const selector = typeof args.flags.l === "string" ? args.flags.l : args.flags.selector;
  if (typeof selector === "string") {
    const [key, value] = selector.split("=");
    pods = pods.filter((p) => p.labels[key] === value);
  }
  if (name) {
    pods = pods.filter((p) => p.name === name);
    if (pods.length === 0) notFound("pods", name);
  }
  if (args.flags.o === "yaml" && pods.length === 1) return podYaml(pods[0], cluster);
  if (pods.length === 0) return `No resources found in ${cluster.namespace} namespace.`;
  const wide = args.flags.o === "wide";
  const labels = args.flags["show-labels"] === true;
  const headers = ["NAME", "READY", "STATUS", "RESTARTS", "AGE", ...(wide ? ["IP", "NODE"] : []), ...(labels ? ["LABELS"] : [])];
  return table(
    headers,
    pods.map((p) => [
      p.name,
      `${p.ready ? 1 : 0}/1`,
      p.status,
      restartsText(p),
      age(p.ageSeconds),
      ...(wide ? [p.ip ?? "<none>", p.node ?? "<none>"] : []),
      ...(labels ? [Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join(",")] : []),
    ]),
  );
}

function podYaml(p: PodView, cluster: Cluster): string {
  const containerStatus: Record<string, unknown> = {
    name: p.container.name,
    image: p.container.image,
    ready: p.ready,
    restartCount: p.restarts,
  };
  if (p.status === "Running") containerStatus.state = { running: {} };
  else if (p.waitingReason) containerStatus.state = { waiting: { reason: p.waitingReason } };
  if (p.lastTermination) {
    containerStatus.lastState = { terminated: { reason: p.lastTermination.reason, exitCode: p.lastTermination.exitCode } };
  }
  const deployment = findDeployment(cluster, p.deployment);
  const template = deploymentToJson(deployment) as { spec: { template: { spec: unknown } } };
  return toYaml({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: p.name, namespace: cluster.namespace, labels: p.labels },
    spec: { nodeName: p.node ?? undefined, ...(template.spec.template.spec as object) } as never,
    status: {
      phase: p.status === "Pending" ? "Pending" : "Running",
      podIP: p.ip ?? undefined,
      containerStatuses: [containerStatus],
    } as never,
  });
}

function getDeployments(cluster: Cluster, args: ParsedArgs, now: number, name?: string): string {
  const deployments = name ? [findDeployment(cluster, name)] : cluster.deployments;
  if (args.flags.o === "yaml" && deployments.length === 1) return toYaml(deploymentToJson(deployments[0]) as never);
  const wide = args.flags.o === "wide";
  return table(
    ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE", ...(wide ? ["CONTAINERS", "IMAGES"] : [])],
    deployments.map((d) => {
      const pods = podsFor(cluster, d, now);
      const upToDate = pods.filter((p) => p.container.image === d.template.containers[0].image &&
        JSON.stringify(p.container) === JSON.stringify(d.template.containers[0])).length;
      return [
        d.name,
        `${readyCount(pods)}/${d.replicas}`,
        String(upToDate),
        String(readyCount(pods)),
        age(serviceAge(cluster, now)),
        ...(wide ? [d.template.containers[0].name, d.template.containers[0].image] : []),
      ];
    }),
  );
}

function getServices(cluster: Cluster, args: ParsedArgs, now: number, name?: string): string {
  const services = name ? [findService(cluster, name)] : cluster.services;
  if (args.flags.o === "yaml" && services.length === 1) return toYaml(serviceToJson(services[0]) as never);
  const wide = args.flags.o === "wide";
  return table(
    ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE", ...(wide ? ["SELECTOR"] : [])],
    services.map((s) => [
      s.name,
      "ClusterIP",
      s.clusterIP,
      "<none>",
      `${s.port}/TCP`,
      age(serviceAge(cluster, now)),
      ...(wide ? [Object.entries(s.selector).map(([k, v]) => `${k}=${v}`).join(",")] : []),
    ]),
  );
}

function getEndpoints(cluster: Cluster, now: number, name?: string): string {
  const services = name ? [findService(cluster, name)] : cluster.services;
  return table(
    ["NAME", "ENDPOINTS", "AGE"],
    services.map((s) => {
      const { ready } = endpointsFor(cluster, s, now);
      const list = ready.map((e) => e.address);
      const shown = list.length > 3 ? `${list.slice(0, 3).join(",")} + ${list.length - 3} more...` : list.join(",");
      return [s.name, shown || "<none>", age(serviceAge(cluster, now))];
    }),
  );
}

function allEvents(cluster: Cluster, now: number): KEvent[] {
  const events: KEvent[] = allPods(cluster, now).flatMap((p) => p.events);
  for (const d of cluster.deployments) {
    const pods = podsFor(cluster, d, now);
    const rs = pods.at(-1)?.labels["pod-template-hash"];
    if (rs) {
      events.push({
        type: "Normal",
        reason: "ScalingReplicaSet",
        object: `deployment/${d.name}`,
        message: `Scaled up replica set ${d.name}-${rs} to ${d.replicas}`,
        ageSeconds: Math.min(...pods.map((p) => p.ageSeconds)),
      });
    }
  }
  return events.sort((a, b) => b.ageSeconds - a.ageSeconds);
}

function getEvents(cluster: Cluster, now: number): string {
  const events = allEvents(cluster, now);
  return table(
    ["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"],
    events.map((e) => [age(e.ageSeconds), e.type, e.reason, e.object, e.message]),
  );
}

function getNodes(cluster: Cluster, now: number): string {
  return table(
    ["NAME", "STATUS", "ROLES", "AGE", "VERSION"],
    cluster.nodes.map((n) => [n.name, "Ready", "<none>", age(serviceAge(cluster, now) + 86400 * 12), "v1.37.0"]),
  );
}

function getReplicaSets(cluster: Cluster, now: number): string {
  const rows: string[][] = [];
  for (const d of cluster.deployments) {
    const pods = podsFor(cluster, d, now);
    const groups = new Map<string, PodView[]>();
    for (const p of pods) {
      const key = p.labels["pod-template-hash"];
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    for (const [hash, group] of groups) {
      rows.push([`${d.name}-${hash}`, String(group.length), String(group.length), String(readyCount(group)), age(group[0].ageSeconds)]);
    }
  }
  return table(["NAME", "DESIRED", "CURRENT", "READY", "AGE"], rows);
}

function get(cluster: Cluster, args: ParsedArgs, now: number): string {
  const first = args.positional[0];
  if (first?.includes("/")) {
    const { kind, name } = target(args.positional);
    return getKind(cluster, kind, args, now, name);
  }
  const kinds = (first ?? "").split(",").map(kindOf);
  const name = args.positional[1];
  return kinds.map((kind) => getKind(cluster, kind, args, now, name)).join("\n\n");
}

function getKind(cluster: Cluster, kind: string, args: ParsedArgs, now: number, name?: string): string {
  const ns = args.flags.n ?? args.flags.namespace;
  if (typeof ns === "string" && ns !== cluster.namespace && kind !== "nodes" && kind !== "namespaces") {
    return `No resources found in ${ns} namespace.`;
  }
  switch (kind) {
    case "pods": return getPods(cluster, args, now, name);
    case "deployments": return getDeployments(cluster, args, now, name);
    case "services": return getServices(cluster, args, now, name);
    case "endpoints": return getEndpoints(cluster, now, name);
    case "events": return getEvents(cluster, now);
    case "nodes": return getNodes(cluster, now);
    case "replicasets": return getReplicaSets(cluster, now);
    case "namespaces":
      return table(["NAME", "STATUS", "AGE"], [[cluster.namespace, "Active", "40d"], ["kube-system", "Active", "40d"]]);
    case "configmaps":
      return table(["NAME", "DATA", "AGE"], cluster.configMaps.map((c) => [c.name, String(Object.keys(c.data).length), "40d"]));
    case "all":
      return [getPods(cluster, args, now), getServices(cluster, args, now), getDeployments(cluster, args, now)].join("\n\n");
    default: return fail(`error: unsupported resource type ${kind}`);
  }
}

// ---------- describe ----------

function eventsBlock(events: KEvent[]): string {
  if (events.length === 0) return "Events:            <none>";
  const rows = [...events]
    .sort((a, b) => b.ageSeconds - a.ageSeconds)
    .map((e) => [e.type, e.reason, age(e.ageSeconds), e.message]);
  return `Events:\n${table(["  Type", "Reason", "Age", "Message"], rows.map((r) => [`  ${r[0]}`, r[1], r[2], r[3]]))}`;
}

function describePod(cluster: Cluster, p: PodView): string {
  const c = p.container;
  const state =
    p.status === "Running"
      ? "Running"
      : p.status === "Pending"
        ? "Waiting\n      Reason:     PodScheduled=False"
        : `Waiting\n      Reason:     ${p.waitingReason ?? p.status}`;
  const lines = [
    `Name:             ${p.name}`,
    `Namespace:        ${cluster.namespace}`,
    `Node:             ${p.node ?? "<none>"}`,
    `Labels:           ${Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join("\n                  ")}`,
    `Status:           ${p.status === "Pending" ? "Pending" : "Running"}`,
    `IP:               ${p.ip ?? ""}`,
    `Controlled By:    ReplicaSet/${p.deployment}-${p.labels["pod-template-hash"]}`,
    "Containers:",
    `  ${c.name}:`,
    `    Image:          ${c.image}`,
    `    Port:           ${c.containerPort ? `${c.containerPort}/TCP` : "<none>"}`,
    `    State:          ${state}`,
  ];
  if (p.lastTermination) {
    lines.push(
      "    Last State:     Terminated",
      `      Reason:       ${p.lastTermination.reason}`,
      `      Exit Code:    ${p.lastTermination.exitCode}`,
    );
  }
  lines.push(`    Ready:          ${p.ready ? "True" : "False"}`, `    Restart Count:  ${p.restarts}`);
  if (c.limits.cpu !== undefined || c.limits.memory !== undefined) {
    lines.push("    Limits:");
    if (c.limits.cpu !== undefined) lines.push(`      cpu:     ${formatCpu(c.limits.cpu)}`);
    if (c.limits.memory !== undefined) lines.push(`      memory:  ${formatMemory(c.limits.memory)}`);
  }
  if (c.requests.cpu !== undefined || c.requests.memory !== undefined) {
    lines.push("    Requests:");
    if (c.requests.cpu !== undefined) lines.push(`      cpu:     ${formatCpu(c.requests.cpu)}`);
    if (c.requests.memory !== undefined) lines.push(`      memory:  ${formatMemory(c.requests.memory)}`);
  }
  if (c.readinessProbe) {
    lines.push(`    Readiness:      http-get http://:${c.readinessProbe.port}${c.readinessProbe.path} delay=0s timeout=1s period=5s`);
  }
  const env = Object.entries(c.env);
  lines.push(`    Environment:${env.length ? "" : "    <none>"}`);
  for (const [k, v] of env) lines.push(`      ${k}:  ${v}`);
  lines.push(
    "Conditions:",
    "  Type              Status",
    `  PodScheduled      ${p.node ? "True" : "False"}`,
    `  Ready             ${p.ready ? "True" : "False"}`,
    `  ContainersReady   ${p.ready ? "True" : "False"}`,
    eventsBlock(p.events),
  );
  return lines.join("\n");
}

function describeDeployment(cluster: Cluster, d: Deployment, now: number): string {
  const pods = podsFor(cluster, d, now);
  const c = d.template.containers[0];
  const lines = [
    `Name:                   ${d.name}`,
    `Namespace:              ${cluster.namespace}`,
    `Annotations:            deployment.kubernetes.io/revision: ${d.revision}`,
    `Selector:               ${Object.entries(d.selector).map(([k, v]) => `${k}=${v}`).join(",")}`,
    `Replicas:               ${d.replicas} desired | ${pods.length} total | ${readyCount(pods)} available | ${pods.length - readyCount(pods)} unavailable`,
    "StrategyType:           RollingUpdate",
    "RollingUpdateStrategy:  25% max unavailable, 25% max surge",
    "Pod Template:",
    `  Labels:  ${Object.entries(d.template.labels).map(([k, v]) => `${k}=${v}`).join(",")}`,
    "  Containers:",
    `   ${c.name}:`,
    `    Image:      ${c.image}`,
    `    Port:       ${c.containerPort ? `${c.containerPort}/TCP` : "<none>"}`,
  ];
  if (c.limits.memory !== undefined || c.limits.cpu !== undefined) {
    lines.push(`    Limits:     cpu=${formatCpu(c.limits.cpu)} memory=${formatMemory(c.limits.memory)}`);
  }
  if (c.requests.memory !== undefined || c.requests.cpu !== undefined) {
    lines.push(`    Requests:   cpu=${formatCpu(c.requests.cpu)} memory=${formatMemory(c.requests.memory)}`);
  }
  if (c.readinessProbe) lines.push(`    Readiness:  http-get http://:${c.readinessProbe.port}${c.readinessProbe.path}`);
  const env = Object.entries(c.env);
  lines.push(`    Environment:${env.length ? "" : "  <none>"}`);
  for (const [k, v] of env) lines.push(`      ${k}:  ${v}`);
  const rs = pods.at(-1)?.labels["pod-template-hash"];
  lines.push(`NewReplicaSet:   ${d.name}-${rs} (${pods.filter((p) => p.labels["pod-template-hash"] === rs).length}/${d.replicas} replicas created)`);
  lines.push(eventsBlock(rs ? [{ type: "Normal", reason: "ScalingReplicaSet", object: d.name, message: `Scaled up replica set ${d.name}-${rs} to ${d.replicas}`, ageSeconds: pods.at(-1)!.ageSeconds }] : []));
  return lines.join("\n");
}

function describeService(cluster: Cluster, s: Service, now: number): string {
  const { ready, notReady } = endpointsFor(cluster, s, now);
  return [
    `Name:              ${s.name}`,
    `Namespace:         ${cluster.namespace}`,
    `Selector:          ${Object.entries(s.selector).map(([k, v]) => `${k}=${v}`).join(",")}`,
    "Type:              ClusterIP",
    `IP:                ${s.clusterIP}`,
    `Port:              <unset>  ${s.port}/TCP`,
    `TargetPort:        ${s.targetPort}/TCP`,
    `Endpoints:         ${ready.map((e) => e.address).join(",") || "<none>"}`,
    ...(notReady.length ? [`NotReadyAddresses: ${notReady.map((e) => e.address).join(",")}`] : []),
    "Events:            <none>",
  ].join("\n");
}

function describeNode(cluster: Cluster, name: string, now: number): string {
  const node = cluster.nodes.find((n) => n.name === name) ?? notFound("nodes", name);
  const pods = allPods(cluster, now).filter((p) => p.node === name);
  const cpu = pods.reduce((sum, p) => sum + (p.container.requests.cpu ?? 0), 250);
  const memory = pods.reduce((sum, p) => sum + (p.container.requests.memory ?? 0), 512);
  return [
    `Name:               ${node.name}`,
    "Roles:              <none>",
    "Conditions:         Ready=True",
    "Allocatable:",
    `  cpu:     ${formatCpu(node.cpu)}`,
    `  memory:  ${formatMemory(node.memory)}`,
    `  pods:    110`,
    `Non-terminated Pods: (${pods.length} in total)`,
    "Allocated resources:",
    `  cpu:     ${formatCpu(cpu)} (${Math.round((cpu / node.cpu) * 100)}%)`,
    `  memory:  ${formatMemory(memory)} (${Math.round((memory / node.memory) * 100)}%)`,
  ].join("\n");
}

function describe(cluster: Cluster, args: ParsedArgs, now: number): string {
  const { kind, name } = target(args.positional);
  switch (kind) {
    case "pods": return describePod(cluster, findPod(cluster, name, now));
    case "deployments": return describeDeployment(cluster, findDeployment(cluster, name), now);
    case "services": return describeService(cluster, findService(cluster, name), now);
    case "nodes": return describeNode(cluster, name, now);
    default: return fail(`error: describe is not supported for ${kind} in this cluster`);
  }
}

// ---------- logs ----------

function logs(cluster: Cluster, args: ParsedArgs, now: number): string {
  const ref = args.positional[0] ?? fail("error: expected 'logs [-p] POD'");
  let pod: PodView;
  if (ref.includes("/")) {
    const { kind, name } = target([ref]);
    if (kind !== "deployments" && kind !== "pods") fail(`error: cannot get logs from ${kind}`);
    pod = kind === "pods" ? findPod(cluster, name, now) : podsFor(cluster, findDeployment(cluster, name), now).at(-1)!;
  } else {
    pod = findPod(cluster, ref, now);
  }
  const previous = args.flags.p === true || args.flags.previous === true;
  if (previous) {
    if (!pod.lastTermination) fail(`Error from server (BadRequest): previous terminated container "${pod.container.name}" in pod "${pod.name}" not found`);
    return pod.previousLogs.join("\n");
  }
  if (!pod.node) return fail(`Error from server (BadRequest): pod ${pod.name} does not have a host assigned`);
  if (pod.status === "ImagePullBackOff") {
    return fail(`Error from server (BadRequest): container "${pod.container.name}" in pod "${pod.name}" is waiting to start: trying and failing to pull image`);
  }
  if (pod.status === "ContainerCreating") {
    return fail(`Error from server (BadRequest): container "${pod.container.name}" in pod "${pod.name}" is waiting to start: ContainerCreating`);
  }
  const tail = typeof args.flags.tail === "string" ? Number.parseInt(args.flags.tail, 10) : undefined;
  const lines = pod.logs;
  return (tail && tail > 0 ? lines.slice(-tail) : lines).join("\n");
}

// ---------- mutations ----------

function deploymentArg(args: ParsedArgs, index = 0): string {
  const { kind, name } = target(args.positional, index);
  if (kind !== "deployments") fail(`error: this command only supports deployments in this cluster`);
  return name;
}

function containerIndex(template: PodTemplate, name: string | undefined): number {
  if (name === undefined) return 0;
  const index = template.containers.findIndex((c) => c.name === name);
  if (index < 0) fail(`error: unable to find container named "${name}"`);
  return index;
}

function setCommand(cluster: Cluster, args: ParsedArgs, now: number): Result {
  const sub = args.positional[0];
  const rest = { ...args, positional: args.positional.slice(1) };
  const name = deploymentArg(rest);
  const deployment = findDeployment(cluster, name);
  const template = clone(deployment.template);
  const firstAssignment = rest.positional[0].includes("/") ? 1 : 2;
  const assignments = rest.positional.slice(firstAssignment);

  if (sub === "env") {
    if (assignments.length === 0) fail("error: at least one environment variable must be provided");
    const c = template.containers[containerIndex(template, rest.flags.c as string | undefined)];
    for (const item of assignments) {
      if (item.endsWith("-") && !item.includes("=")) delete c.env[item.slice(0, -1)];
      else {
        const eq = item.indexOf("=");
        if (eq <= 0) fail(`error: invalid environment variable "${item}", expected KEY=VALUE`);
        c.env[item.slice(0, eq)] = item.slice(eq + 1);
      }
    }
    const changed = updateTemplate(deployment, template, `kubectl set env deployment/${name}`, now);
    return { output: `deployment.apps/${name} ${changed ? "env updated" : "unchanged"}`, changed };
  }

  if (sub === "image") {
    if (assignments.length === 0) fail("error: expected CONTAINER=IMAGE");
    for (const item of assignments) {
      const [containerName, image] = item.split(/=(.*)/s, 2);
      if (!image) fail(`error: invalid image assignment "${item}", expected CONTAINER=IMAGE`);
      template.containers[containerIndex(template, containerName)].image = image;
    }
    const changed = updateTemplate(deployment, template, `kubectl set image deployment/${name} ${assignments.join(" ")}`, now);
    return { output: `deployment.apps/${name} ${changed ? "image updated" : "unchanged"}`, changed };
  }

  if (sub === "resources") {
    const c = template.containers[containerIndex(template, rest.flags.c as string | undefined)];
    const apply = (spec: string | true | undefined, into: "limits" | "requests") => {
      if (typeof spec !== "string") return;
      for (const pair of spec.split(",")) {
        const [resource, value] = pair.split("=");
        if (resource === "cpu") c[into].cpu = parseCpu(value);
        else if (resource === "memory") c[into].memory = parseMemory(value);
        else fail(`error: unsupported resource "${resource}"`);
      }
    };
    if (rest.flags.limits === undefined && rest.flags.requests === undefined) fail("error: you must specify --limits or --requests");
    apply(rest.flags.limits, "limits");
    apply(rest.flags.requests, "requests");
    for (const r of ["cpu", "memory"] as const) {
      const req = c.requests[r];
      const lim = c.limits[r];
      if (req !== undefined && lim !== undefined && req > lim) {
        const show = r === "cpu" ? formatCpu : formatMemory;
        fail(
          `The Deployment "${name}" is invalid: spec.template.spec.containers[0].resources.requests: ` +
            `Invalid value: "${show(req)}": must be less than or equal to ${r} limit of ${show(lim)}`,
        );
      }
    }
    const changed = updateTemplate(deployment, template, `kubectl set resources deployment/${name}`, now);
    return { output: `deployment.apps/${name} resource requirements ${changed ? "updated" : "unchanged"}`, changed };
  }

  return fail(`error: unknown set subcommand "${sub}". Supported: env, image, resources`);
}

function patch(cluster: Cluster, args: ParsedArgs, now: number): Result {
  const { kind, name } = target(args.positional);
  const raw = args.flags.p ?? args.flags.patch;
  if (typeof raw !== "string") fail("error: must specify -p to patch");
  let body: unknown;
  try {
    body = JSON.parse(raw as string);
  } catch {
    return fail(`error: unable to parse "${raw}": invalid JSON`);
  }
  if (kind === "deployments") {
    const deployment = findDeployment(cluster, name);
    const merged = strategicMerge(deploymentToJson(deployment), body) as Record<string, unknown>;
    let result: ReturnType<typeof templateFromDeploymentJson>;
    try {
      result = templateFromDeploymentJson(merged);
    } catch (e) {
      return fail(`The Deployment "${name}" is invalid: ${(e as Error).message}`);
    }
    if (!Object.entries(deployment.selector).every(([k, v]) => result.template.labels[k] === v)) {
      fail(`The Deployment "${name}" is invalid: spec.template.metadata.labels: Invalid value: selector does not match template labels`);
    }
    const scaled = result.replicas !== deployment.replicas;
    deployment.replicas = Math.max(0, result.replicas);
    const changed = updateTemplate(deployment, result.template, `kubectl patch deployment ${name}`, now) || scaled;
    return { output: `deployment.apps/${name} ${changed ? "patched" : "patched (no change)"}`, changed };
  }
  if (kind === "services") {
    const service = findService(cluster, name);
    const before = JSON.stringify(service);
    const fields = serviceFieldsFromJson(strategicMerge(serviceToJson(service), body) as Record<string, unknown>);
    if (!Number.isFinite(fields.port) || !Number.isFinite(fields.targetPort)) fail(`The Service "${name}" is invalid: spec.ports: invalid port`);
    Object.assign(service, fields);
    const changed = JSON.stringify(service) !== before;
    return { output: `service/${name} ${changed ? "patched" : "patched (no change)"}`, changed };
  }
  return fail(`error: patching ${kind} is not supported in this cluster`);
}

function rollout(cluster: Cluster, args: ParsedArgs, now: number): Result {
  const sub = args.positional[0];
  const name = deploymentArg({ ...args, positional: args.positional.slice(1) });
  const d = findDeployment(cluster, name);
  switch (sub) {
    case "history": {
      const rows = [...d.history.map((h) => [String(h.revision), h.cause || "<none>"]), [String(d.revision), d.changeCause || "<none>"]];
      return { output: `deployment.apps/${name}\n${table(["REVISION", "CHANGE-CAUSE"], rows)}` };
    }
    case "undo": {
      const previous = d.history.pop() ?? fail(`error: no rollout history found for deployment "${name}"`);
      d.history.push({ revision: d.revision, template: d.template, cause: d.changeCause });
      d.template = clone(previous!.template);
      d.changeCause = previous!.cause;
      d.revision += 1;
      d.updatedAt = now;
      return { output: `deployment.apps/${name} rolled back`, changed: true };
    }
    case "restart": {
      d.updatedAt = now;
      return { output: `deployment.apps/${name} restarted`, changed: true };
    }
    case "status": {
      const pods = podsFor(cluster, d, now);
      const done = pods.length === d.replicas && readyCount(pods) === d.replicas;
      return {
        output: done
          ? `deployment "${name}" successfully rolled out`
          : `Waiting for deployment "${name}" rollout to finish: ${readyCount(pods)} of ${d.replicas} updated replicas are available...`,
      };
    }
    default:
      return fail(`error: unknown rollout subcommand "${sub}". Supported: history, undo, restart, status`);
  }
}

function scale(cluster: Cluster, args: ParsedArgs): Result {
  const name = deploymentArg(args);
  const replicas = Number(args.flags.replicas);
  if (!Number.isInteger(replicas) || replicas < 0) fail("error: --replicas must be a non-negative integer");
  const d = findDeployment(cluster, name);
  if (replicas > 10) fail("error: this cluster is small, keep --replicas at 10 or below");
  const changed = d.replicas !== replicas;
  d.replicas = replicas;
  return { output: `deployment.apps/${name} scaled`, changed };
}

function exec(cluster: Cluster, args: ParsedArgs, now: number): string {
  const podName = args.positional[0] ?? fail("error: expected 'exec POD -- COMMAND'");
  const pod = findPod(cluster, podName, now);
  if (pod.status !== "Running") fail(`error: unable to upgrade connection: container not found ("${pod.container.name}")`);
  const [command, ...rest] = args.rest;
  if (!command) fail("error: you must specify at least one command for the container");
  if (command === "env") {
    return Object.entries({ HOSTNAME: pod.name, ...pod.container.env }).map(([k, v]) => `${k}=${v}`).join("\n");
  }
  if (command === "curl" || command === "wget") {
    const url = rest.filter((r) => !r.startsWith("-")).at(-1);
    if (!url) fail(`${command}: no URL specified`);
    return curl(cluster, url!, now).output;
  }
  return fail(
    `OCI runtime exec failed: exec failed: unable to start container process: exec: "${command}": executable file not found in $PATH: unknown`,
  );
}

function top(cluster: Cluster, args: ParsedArgs, now: number): string {
  const kind = kindOf(args.positional[0] ?? "pods");
  if (kind === "nodes") {
    return table(
      ["NAME", "CPU(cores)", "CPU%", "MEMORY(bytes)", "MEMORY%"],
      cluster.nodes.map((n) => {
        const pods = allPods(cluster, now).filter((p) => p.node === n.name);
        const cpu = pods.reduce((s, p) => s + p.cpuUsage, 180);
        const mem = pods.reduce((s, p) => s + p.memoryUsage, 900);
        return [n.name, formatCpu(cpu), `${Math.round((cpu / n.cpu) * 100)}%`, formatMemory(mem), `${Math.round((mem / n.memory) * 100)}%`];
      }),
    );
  }
  const pods = allPods(cluster, now).filter((p) => p.status === "Running" || p.memoryUsage > 0);
  return table(["NAME", "CPU(cores)", "MEMORY(bytes)"], pods.map((p) => [p.name, `${p.cpuUsage}m`, `${p.memoryUsage}Mi`]));
}

function deleteCommand(cluster: Cluster, args: ParsedArgs, now: number): Result {
  const { kind, name } = target(args.positional);
  if (kind !== "pods") {
    return fail(`error: deleting ${kind} is disabled here: the cluster must be fixed, not removed`);
  }
  const pod = findPod(cluster, name, now);
  const d = findDeployment(cluster, pod.deployment);
  d.updatedAt = now;
  return { output: `pod "${name}" deleted`, changed: true };
}

const HELP = `Supported kubectl commands:
  get        pods | deploy | svc | endpoints | events | nodes | rs | cm | all   [-o wide|yaml] [-l key=value]
  describe   pod | deploy | svc | node NAME
  logs       POD [--previous] [--tail=N]
  exec       POD -- curl http://SERVICE[:PORT][/path]
  top        pods | nodes
  set        env | image | resources  deployment/NAME ...
  patch      deployment|service NAME -p '{"spec":...}'
  rollout    history | undo | restart | status  deployment/NAME
  scale      deployment/NAME --replicas=N
  delete     pod NAME`;

export function kubectl(cluster: Cluster, line: string, now: number): Result {
  let words: string[];
  try {
    words = tokenize(line.trim());
  } catch (e) {
    return { output: `error: ${(e as Error).message}`, error: true };
  }
  if (words[0] === "k") words[0] = "kubectl";
  if (words[0] !== "kubectl") return { output: `${words[0]}: command not found`, error: true };
  const [verb, ...rest] = words.slice(1);
  const args = verb === "patch" ? parseArgs(rest, PATCH_BOOLEANS) : parseArgs(rest);

  try {
    switch (verb) {
      case undefined:
      case "help":
        return { output: HELP };
      case "get": return { output: get(cluster, args, now) };
      case "describe": return { output: describe(cluster, args, now) };
      case "logs": return { output: logs(cluster, args, now) };
      case "exec": return { output: exec(cluster, args, now) };
      case "top": return { output: top(cluster, args, now) };
      case "set": return setCommand(cluster, args, now);
      case "patch": return patch(cluster, args, now);
      case "rollout": return rollout(cluster, args, now);
      case "scale": return scale(cluster, args);
      case "delete": return deleteCommand(cluster, args, now);
      case "edit":
        return { output: "error: there is no editor in this terminal, use kubectl patch or kubectl set", error: true };
      case "apply":
      case "create":
        return { output: "error: there are no manifest files here, fix the existing resources with set, patch, scale or rollout", error: true };
      case "version":
        return { output: "Client Version: v1.37.2\nKustomize Version: v5.8.1\nServer Version: v1.37.0" };
      case "cluster-info":
        return { output: "Kubernetes control plane is running at https://127.0.0.1:6443\nCoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy" };
      default:
        return { output: `error: unknown command "${verb}" for "kubectl"\nRun 'kubectl help' for usage.`, error: true };
    }
  } catch (e) {
    if (e instanceof KubectlError) return { output: e.message, error: true };
    if (e instanceof Error) return { output: `error: ${e.message}`, error: true };
    throw e;
  }
}
