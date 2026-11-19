import { allPods } from "../cluster/simulate";
import type { Cluster } from "../cluster/types";
import { kubectl } from "../kubectl/kubectl";
import { LEVELS, type Level } from "../levels/levels";

export type Line = { kind: "cmd" | "out" | "err" | "sys" | "ok" | "hint"; text: string };

const VERBS = ["get", "describe", "logs", "exec", "top", "set", "patch", "rollout", "scale", "delete", "version"];
const KINDS = ["pods", "deployments", "services", "endpoints", "events", "nodes", "replicasets", "all"];
const BUILTINS = ["kubectl", "help", "hint", "clear", "reset", "levels", "next", "level"];

export const HELP_TEXT = `Game commands:
  help         this help
  hint         reveal the next hint for this incident
  reset        put the cluster back in its broken state
  levels       list incidents and your stars
  level N      jump to incident N
  clear        clear the terminal (or Ctrl+L)

Everything else is kubectl. Try \`kubectl help\` for the supported commands.
Tab completes commands and resource names, Up/Down browse your history.`;

export class Game {
  index = 0;
  cluster!: Cluster;
  commands = 0;
  hints = 0;
  solved = false;

  constructor(private readonly clock: () => number = Date.now) {}

  get level(): Level {
    return LEVELS[this.index];
  }

  load(index: number): void {
    this.index = Math.max(0, Math.min(index, LEVELS.length - 1));
    this.cluster = this.level.setup(this.clock());
    this.commands = 0;
    this.hints = 0;
    this.solved = false;
  }

  isSolved(): boolean {
    return this.level.solved(this.cluster, this.clock());
  }

  nextHint(): string | null {
    if (this.hints >= this.level.hints.length) return null;
    return this.level.hints[this.hints++];
  }

  run(line: string): Line[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    this.commands += 1;
    const result = kubectl(this.cluster, trimmed, this.clock());
    return [{ kind: result.error ? "err" : "out", text: result.output }];
  }

  complete(input: string): string[] {
    const words = input.split(/\s+/);
    const current = words.at(-1) ?? "";
    const previous = words.slice(0, -1);
    let candidates: string[] = [];

    if (previous.length === 0) candidates = BUILTINS;
    else if (previous[0] === "kubectl" || previous[0] === "k") {
      if (previous.length === 1) candidates = VERBS;
      else if (["get", "describe"].includes(previous[1]) && previous.length === 2) candidates = KINDS;
      else candidates = this.resourceNames(previous);
    }
    return candidates.filter((c) => c.startsWith(current) && c !== current);
  }

  private resourceNames(previous: string[]): string[] {
    const now = this.clock();
    const kind = previous.at(-1) ?? "";
    const pods = allPods(this.cluster, now).map((p) => p.name);
    const deployments = this.cluster.deployments.map((d) => d.name);
    const services = this.cluster.services.map((s) => s.name);
    if (/^(po|pod|pods)$/.test(kind) || ["logs", "exec"].includes(kind)) return pods;
    if (/^(deploy|deployment|deployments)$/.test(kind)) return deployments;
    if (/^(svc|service|services|ep|endpoints)$/.test(kind)) return services;
    if (["env", "image", "resources", "scale", "restart", "undo", "history", "status"].includes(kind)) {
      return deployments.map((d) => `deployment/${d}`);
    }
    return [...pods, ...deployments.map((d) => `deployment/${d}`)];
  }
}
