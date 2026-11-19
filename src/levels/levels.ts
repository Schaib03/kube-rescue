import type { Cluster } from "../cluster/types";
import { cluster, container, deployment, healthy, noFailingPods, reachable, service, toolbox } from "./builders";

export interface Level {
  id: string;
  title: string;
  ticket: string;
  goal: string;
  setup: (now: number) => Cluster;
  solved: (c: Cluster, now: number) => boolean;
  hints: string[];
  par: number;
  solution: string[];
  lesson: string;
}

const IMG = "ghcr.io/acme";

export const LEVELS: Level[] = [
  {
    id: "crashloop",
    title: "Payments is down",
    ticket:
      "Checkout fails since this morning's deploy. The payments pods keep restarting. " +
      "The DBA confirms the database is up at postgres://payments@postgres.shop:5432/payments.",
    goal: "Every payments pod is Running and Ready.",
    setup: (now) =>
      cluster(
        now,
        [deployment("payments", container("payments", `${IMG}/payments:2.1.0`), { replicas: 2 })],
        [service("payments", { app: "payments" })],
      ),
    solved: (c, now) => healthy(c, "payments", now, 2),
    hints: [
      "Start with `kubectl get pods`. Which status looks wrong?",
      "A crashing container usually says why in its logs: `kubectl logs <pod-name>`.",
      "Environment variables are set on the Deployment, not the pod: `kubectl set env deployment/payments KEY=VALUE`.",
    ],
    par: 4,
    solution: ["kubectl set env deployment/payments DATABASE_URL=postgres://payments@postgres.shop:5432/payments"],
    lesson:
      "CrashLoopBackOff means the container starts, exits, and Kubernetes waits longer before each restart. " +
      "The answer is almost always in `kubectl logs` (add `--previous` for the last crashed run).",
  },
  {
    id: "bad-release",
    title: "The release candidate",
    ticket:
      "Someone deployed web 1.4.0-rc to production by mistake. Half the team says the site is fine, " +
      "the dashboard says the deployment is stuck. Get production back to a clean state.",
    goal: "The web deployment runs only images that exist, with all 3 replicas ready.",
    setup: (now) => {
      const stable = container("web", `${IMG}/web:1.3.2`);
      const d = deployment("web", container("web", `${IMG}/web:1.4.0-rc`), {
        replicas: 3,
        history: [{ labels: { app: "web" }, containers: [stable] }],
      });
      d.changeCause = `kubectl set image deployment/web web=${IMG}/web:1.4.0-rc`;
      return cluster(now, [d], [service("web", { app: "web" })]);
    },
    solved: (c, now) => healthy(c, "web", now, 3) && noFailingPods(c, now),
    hints: [
      "`kubectl get pods`: the old pods still serve traffic, but one new pod is stuck.",
      "`kubectl describe pod <stuck-pod>` and read the Events at the bottom.",
      "Deployments keep their previous revisions: `kubectl rollout history deployment/web`, then `kubectl rollout undo deployment/web`.",
    ],
    par: 4,
    solution: ["kubectl rollout undo deployment/web"],
    lesson:
      "A rolling update never takes down the old ReplicaSet until new pods are ready, so a bad image " +
      "stalls instead of breaking the site. `kubectl rollout undo` returns to the previous revision.",
  },
  {
    id: "oomkilled",
    title: "The worker that keeps dying",
    ticket:
      "The catalogue worker restarts every few minutes and the nightly import never finishes. " +
      "There is nothing useful in the application logs.",
    goal: "The worker pod is Running and Ready.",
    setup: (now) =>
      cluster(
        now,
        [
          deployment(
            "worker",
            container("worker", `${IMG}/worker:3.0.1`, {
              containerPort: undefined,
              requests: { cpu: 100, memory: 128 },
              limits: { memory: 128 },
            }),
          ),
        ],
        [],
      ),
    solved: (c, now) => healthy(c, "worker", now, 1),
    hints: [
      "The logs end abruptly, as if the process was killed from outside.",
      "`kubectl describe pod <worker-pod>`: look at Last State, its Reason and Exit Code.",
      "Exit code 137 with OOMKilled means the memory limit is too low: `kubectl set resources deployment/worker --limits=memory=256Mi`.",
    ],
    par: 4,
    solution: ["kubectl set resources deployment/worker --limits=memory=256Mi"],
    lesson:
      "OOMKilled (exit code 137) means the container used more memory than its limit and the kernel killed it. " +
      "Raise the limit, or make the app use less memory. `kubectl top pods` shows actual usage.",
  },
  {
    id: "selector",
    title: "Nobody answers",
    ticket:
      "After a refactoring of the labels, the api pods are all healthy but every call to " +
      "http://api from inside the cluster fails. Test it from the toolbox pod.",
    goal: "`curl http://api` works from the toolbox pod.",
    setup: (now) =>
      cluster(
        now,
        [
          deployment("api", container("api", `${IMG}/api:1.8.0`), {
            replicas: 2,
            labels: { app: "api", tier: "backend" },
          }),
          toolbox(),
        ],
        [service("api", { app: "api-server" })],
      ),
    solved: (c, now) => reachable(c, "http://api", now),
    hints: [
      "Try it: `kubectl exec <toolbox-pod> -- curl http://api`.",
      "A Service sends traffic to its endpoints: `kubectl get endpoints api`. Why are there none?",
      "Compare `kubectl describe svc api` (Selector) with the pod labels in `kubectl get pods --show-labels` or `kubectl describe pod`. Fix it with `kubectl patch service api -p '{\"spec\":{\"selector\":{\"app\":\"api\"}}}'`.",
    ],
    par: 5,
    solution: [`kubectl patch service api -p '{"spec":{"selector":{"app":"api"}}}'`],
    lesson:
      "Services find pods by label selector. If the selector matches no pod, the Service has no endpoints " +
      "and connections are refused even though every pod is healthy.",
  },
  {
    id: "targetport",
    title: "Connection refused",
    ticket:
      "The checkout service has endpoints, the pods are green, yet http://checkout refuses every connection.",
    goal: "`curl http://checkout` works from the toolbox pod.",
    setup: (now) =>
      cluster(
        now,
        [deployment("checkout", container("checkout", `${IMG}/checkout:4.2.0`), { replicas: 2 }), toolbox()],
        [service("checkout", { app: "checkout" }, 80)],
      ),
    solved: (c, now) => reachable(c, "http://checkout", now),
    hints: [
      "`kubectl get endpoints checkout`: which port do the endpoints use?",
      "`kubectl describe pod <checkout-pod>` or its logs: which port does the app listen on?",
      "The Service's targetPort must be the container port: `kubectl patch svc checkout -p '{\"spec\":{\"ports\":[{\"port\":80,\"targetPort\":8080}]}}'`.",
    ],
    par: 5,
    solution: [`kubectl patch svc checkout -p '{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`],
    lesson:
      "`port` is what clients call on the Service, `targetPort` is where traffic goes on the pod. " +
      "They often differ (80 → 8080), and a wrong targetPort gives connection refused.",
  },
  {
    id: "readiness",
    title: "Running, but not ready",
    ticket:
      "The new catalog service never receives traffic. Its pods are Running, but the Service has no endpoints.",
    goal: "All catalog pods are Ready and `curl http://catalog` works.",
    setup: (now) =>
      cluster(
        now,
        [
          deployment(
            "catalog",
            container("catalog", `${IMG}/api:1.8.0`, { readinessProbe: { path: "/healthz", port: 8080 } }),
            { replicas: 2 },
          ),
          toolbox(),
        ],
        [service("catalog", { app: "catalog" })],
      ),
    solved: (c, now) => healthy(c, "catalog", now, 2) && reachable(c, "http://catalog", now),
    hints: [
      "READY 0/1 with STATUS Running means the readiness probe fails.",
      "`kubectl describe pod <catalog-pod>`: read the Unhealthy event, then check which paths the app serves in its logs.",
      "Patch the probe path: `kubectl patch deployment catalog -p '{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"catalog\",\"readinessProbe\":{\"httpGet\":{\"path\":\"/health\"}}}]}}}}'`.",
    ],
    par: 4,
    solution: [
      `kubectl patch deployment catalog -p '{"spec":{"template":{"spec":{"containers":[{"name":"catalog","readinessProbe":{"httpGet":{"path":"/health"}}}]}}}}'`,
    ],
    lesson:
      "A pod only receives Service traffic once its readiness probe passes. A wrong probe path (404) keeps a " +
      "perfectly good pod out of rotation. Liveness probes, on the other hand, restart the container.",
  },
  {
    id: "pending",
    title: "Stuck in Pending",
    ticket:
      "The monthly reports job was redeployed with new settings an hour ago and its pod never started. " +
      "No logs, no restarts, nothing.",
    goal: "The reports pod is scheduled, Running and Ready.",
    setup: (now) =>
      cluster(
        now,
        [
          deployment(
            "reports",
            container("reports", `${IMG}/reports:0.9.4`, {
              containerPort: undefined,
              requests: { cpu: 3000, memory: 512 },
              limits: { memory: 1024 },
            }),
          ),
        ],
        [],
      ),
    solved: (c, now) => healthy(c, "reports", now, 1),
    hints: [
      "A Pending pod has not been placed on a node yet. `kubectl describe pod <reports-pod>`.",
      "Compare the pod's cpu request with what a node can offer: `kubectl describe node node-1`.",
      "Ask for less: `kubectl set resources deployment/reports --requests=cpu=500m`.",
    ],
    par: 4,
    solution: ["kubectl set resources deployment/reports --requests=cpu=500m"],
    lesson:
      "The scheduler places pods using their requests, not their real usage. If no node has enough " +
      "unreserved CPU or memory, the pod stays Pending with a FailedScheduling event.",
  },
  {
    id: "black-friday",
    title: "Black Friday",
    ticket:
      "Black Friday starts in ten minutes. The new frontend crashes, http://frontend is unreachable, " +
      "and marketing expects three times the usual traffic. The frontend talks to the API at http://api.",
    goal: "frontend runs 3 ready replicas and `curl http://frontend` works.",
    setup: (now) =>
      cluster(
        now,
        [
          deployment("frontend", container("frontend", `${IMG}/frontend:5.0.0`)),
          deployment("api", container("api", `${IMG}/api:1.8.0`), { replicas: 2 }),
          toolbox(),
        ],
        [service("frontend", { app: "frontend" }, 80), service("api", { app: "api" })],
      ),
    solved: (c, now) => healthy(c, "frontend", now, 3) && reachable(c, "http://frontend", now),
    hints: [
      "Three problems hide here. Start with the crashing pod and its logs.",
      "Once frontend runs, test it from the toolbox pod and compare the Service targetPort with the container port.",
      "Finally: `kubectl scale deployment/frontend --replicas=3`.",
    ],
    par: 9,
    solution: [
      "kubectl set env deployment/frontend API_URL=http://api",
      `kubectl patch svc frontend -p '{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`,
      "kubectl scale deployment/frontend --replicas=3",
    ],
    lesson:
      "Real incidents rarely have one cause. Fix what you can see, verify, and look again: " +
      "get, describe, logs, endpoints, and a test request from inside the cluster.",
  },
];
