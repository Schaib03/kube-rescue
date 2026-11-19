import { describe, expect, it } from "vitest";
import { TRANSITION_MS } from "../src/cluster/simulate";
import { kubectl } from "../src/kubectl/kubectl";
import { LEVELS } from "../src/levels/levels";

const T0 = 1_800_000_000_000;
const later = T0 + TRANSITION_MS + 10;

describe.each(LEVELS)("level $id", (level) => {
  it("starts broken", () => {
    const cluster = level.setup(T0);
    expect(level.solved(cluster, T0)).toBe(false);
    expect(level.solved(cluster, T0 + 3_600_000)).toBe(false);
  });

  it("is solved by its reference solution", () => {
    const cluster = level.setup(T0);
    for (const command of level.solution) {
      const result = kubectl(cluster, command, T0 + 1000);
      expect(result.error, `${command}\n${result.output}`).toBeFalsy();
    }
    expect(level.solved(cluster, later + 1000)).toBe(true);
  });

  it("has three hints and a par at least as long as the solution", () => {
    expect(level.hints).toHaveLength(3);
    expect(level.par).toBeGreaterThanOrEqual(level.solution.length);
  });
});

describe("partial or wrong fixes do not count", () => {
  const byId = Object.fromEntries(LEVELS.map((l) => [l.id, l]));

  it("an invalid database URL keeps payments crashing", () => {
    const cluster = byId.crashloop.setup(T0);
    kubectl(cluster, "kubectl set env deployment/payments DATABASE_URL=localhost", T0);
    expect(byId.crashloop.solved(cluster, later)).toBe(false);
    const pods = kubectl(cluster, "kubectl get pods", later).output;
    expect(pods).toContain("CrashLoopBackOff");
  });

  it("a memory limit just below the need is still OOMKilled", () => {
    const cluster = byId.oomkilled.setup(T0);
    kubectl(cluster, "kubectl set resources deployment/worker --limits=memory=200Mi", T0);
    expect(byId.oomkilled.solved(cluster, later)).toBe(false);
  });

  it("the pods are not ready while they are being created", () => {
    const cluster = byId.crashloop.setup(T0);
    kubectl(cluster, byId.crashloop.solution[0], T0);
    expect(byId.crashloop.solved(cluster, T0 + 200)).toBe(false);
    expect(kubectl(cluster, "kubectl get pods", T0 + 200).output).toContain("ContainerCreating");
  });

  it("black friday needs all three fixes", () => {
    const level = byId["black-friday"];
    const cluster = level.setup(T0);
    kubectl(cluster, level.solution[0], T0);
    kubectl(cluster, level.solution[2], T0);
    expect(level.solved(cluster, later)).toBe(false);
    kubectl(cluster, level.solution[1], T0);
    expect(level.solved(cluster, later)).toBe(true);
  });

  it("setting the image back by hand also fixes the release", () => {
    const cluster = byId["bad-release"].setup(T0);
    kubectl(cluster, "kubectl set image deployment/web web=ghcr.io/acme/web:1.3.2", T0);
    expect(byId["bad-release"].solved(cluster, later)).toBe(true);
  });
});
