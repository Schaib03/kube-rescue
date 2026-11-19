import { describe, expect, it } from "vitest";
import { strategicMerge } from "../src/cluster/manifest";
import { parseCpu, parseMemory } from "../src/cluster/quantity";
import { TRANSITION_MS } from "../src/cluster/simulate";
import { age, toYaml } from "../src/kubectl/format";
import { kubectl } from "../src/kubectl/kubectl";
import { parseArgs, tokenize } from "../src/kubectl/tokenize";
import { LEVELS } from "../src/levels/levels";

const T0 = 1_800_000_000_000;
const level = (id: string) => LEVELS.find((l) => l.id === id)!;
const run = (id: string, ...commands: string[]) => {
  const cluster = level(id).setup(T0);
  return commands.map((c) => kubectl(cluster, c, T0 + TRANSITION_MS + 100));
};
const podName = (id: string, prefix: string) =>
  run(id, "kubectl get pods")[0].output.split("\n").find((l) => l.startsWith(prefix))!.split(/\s+/)[0];

describe("tokenize and flags", () => {
  it("keeps quoted JSON together", () => {
    expect(tokenize(`kubectl patch svc api -p '{"spec": {"a": 1}}'`)).toEqual([
      "kubectl", "patch", "svc", "api", "-p", '{"spec": {"a": 1}}',
    ]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => tokenize(`kubectl patch -p '{"a"`)).toThrow();
  });

  it("parses short, long and boolean flags and the -- separator", () => {
    const parsed = parseArgs(["pods", "-o", "wide", "--tail=5", "-p", "x", "--", "curl", "http://api"]);
    expect(parsed.positional).toEqual(["pods", "x"]);
    expect(parsed.flags).toEqual({ o: "wide", tail: "5", p: true });
    expect(parsed.rest).toEqual(["curl", "http://api"]);
  });
});

describe("helpers", () => {
  it("parses quantities", () => {
    expect(parseCpu("500m")).toBe(500);
    expect(parseCpu("1.5")).toBe(1500);
    expect(parseMemory("256Mi")).toBe(256);
    expect(parseMemory("1Gi")).toBe(1024);
    expect(() => parseMemory("lots")).toThrow();
  });

  it("formats ages like kubectl", () => {
    expect(age(42)).toBe("42s");
    expect(age(150)).toBe("2m30s");
    expect(age(25 * 60)).toBe("25m");
    expect(age(5 * 3600)).toBe("5h");
  });

  it("merges containers by name and deletes keys with null", () => {
    const merged = strategicMerge(
      { spec: { containers: [{ name: "a", image: "x", env: [{ name: "K", value: "1" }] }], keep: 1, drop: 2 } },
      { spec: { containers: [{ name: "a", env: [{ name: "L", value: "2" }] }], drop: null } },
    );
    expect(merged).toEqual({
      spec: {
        containers: [{ name: "a", image: "x", env: [{ name: "K", value: "1" }, { name: "L", value: "2" }] }],
        keep: 1,
      },
    });
  });

  it("renders YAML", () => {
    expect(toYaml({ a: 1, b: { c: "x:y", f: "a: b" }, d: [{ e: true, g: "8080" }] })).toBe(
      'a: 1\nb:\n  c: x:y\n  f: "a: b"\nd:\n- e: true\n  g: "8080"',
    );
  });
});

describe("kubectl output", () => {
  it("shows a crash loop and the reason in the logs", () => {
    const pod = podName("crashloop", "payments-");
    const [pods, logs] = run("crashloop", "kubectl get pods", `kubectl logs ${pod}`);
    expect(pods.output).toMatch(/payments-\S+\s+0\/1\s+CrashLoopBackOff/);
    expect(logs.output).toContain("DATABASE_URL is not set");
  });

  it("explains an OOM kill in describe", () => {
    const pod = podName("oomkilled", "worker-");
    const [describe] = run("oomkilled", `kubectl describe pod ${pod}`);
    expect(describe.output).toContain("OOMKilled");
    expect(describe.output).toContain("Exit Code:    137");
    expect(describe.output).toContain("memory:  128Mi");
  });

  it("shows the image pull failure next to the old pods", () => {
    const [pods] = run("bad-release", "kubectl get pods");
    expect(pods.output.match(/Running/g)).toHaveLength(3);
    expect(pods.output).toContain("ImagePullBackOff");
    const [history] = run("bad-release", "kubectl rollout history deployment/web");
    expect(history.output).toContain("web:1.4.0-rc");
  });

  it("reports a service without endpoints and a refused connection", () => {
    const toolbox = podName("selector", "toolbox-");
    const [endpoints, curl] = run("selector", "kubectl get endpoints api", `kubectl exec -it ${toolbox} -- curl http://api`);
    expect(endpoints.output).toMatch(/api\s+<none>/);
    expect(curl.output).toContain("Couldn't connect to server");
  });

  it("explains a pending pod", () => {
    const pod = podName("pending", "reports-");
    const [pods, describe] = run("pending", "kubectl get pods", `kubectl describe pod ${pod}`);
    expect(pods.output).toContain("Pending");
    expect(describe.output).toContain("2 Insufficient cpu");
  });

  it("shows readiness probe failures", () => {
    const pod = podName("readiness", "catalog-");
    const [describe, logs] = run("readiness", `kubectl describe pod ${pod}`, `kubectl logs ${pod}`);
    expect(describe.output).toContain("HTTP probe failed with statuscode: 404");
    expect(logs.output).toContain("GET /healthz 404");
  });

  it("prints useful errors", () => {
    const [missing, unknown, verb, notKubectl] = run(
      "crashloop",
      "kubectl get pod nope",
      "kubectl get widgets",
      "kubectl frobnicate",
      "ls -la",
    );
    expect(missing.output).toBe('Error from server (NotFound): pods "nope" not found');
    expect(unknown.output).toContain(`doesn't have a resource type "widgets"`);
    expect(verb.output).toContain('unknown command "frobnicate"');
    expect(notKubectl.output).toBe("ls: command not found");
    expect([missing, unknown, verb, notKubectl].every((r) => r.error)).toBe(true);
  });

  it("validates resource requests against limits", () => {
    const [result] = run("oomkilled", "kubectl set resources deployment/worker --requests=memory=512Mi");
    expect(result.error).toBe(true);
    expect(result.output).toContain("must be less than or equal to memory limit");
  });

  it("supports the k alias, yaml output and rollout status", () => {
    const [yaml, status] = run("crashloop", "k get deploy payments -o yaml", "kubectl rollout status deployment/payments");
    expect(yaml.output).toContain("kind: Deployment");
    expect(yaml.output).toContain("image: ghcr.io/acme/payments:2.1.0");
    expect(status.output).toContain("Waiting for deployment");
  });
});
