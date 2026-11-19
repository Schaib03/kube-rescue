export interface EnvRequirement {
  name: string;
  check?: (value: string) => string | null;
}

export interface ImageBehavior {
  port: number;
  healthPath: string;
  memory: number;
  cpu: number;
  requiredEnv: EnvRequirement[];
  startup: string[];
  response: string;
}

const postgresUrl = (value: string) =>
  /^postgres(ql)?:\/\/\S+$/.test(value) ? null : `invalid DATABASE_URL "${value}"`;

const base = {
  port: 8080,
  healthPath: "/healthz",
  memory: 96,
  cpu: 40,
  requiredEnv: [],
  response: '{"status":"ok"}',
};

export const REGISTRY: Record<string, ImageBehavior> = {
  "ghcr.io/acme/payments:2.1.0": {
    ...base,
    memory: 140,
    requiredEnv: [{ name: "DATABASE_URL", check: postgresUrl }],
    startup: ["payments 2.1.0 starting", "connecting to database"],
    response: '{"service":"payments","status":"ok"}',
  },
  "ghcr.io/acme/web:1.3.2": {
    ...base,
    startup: ["web 1.3.2 listening on :8080"],
    response: "<html><title>Acme shop</title>...</html>",
  },
  "ghcr.io/acme/worker:3.0.1": {
    ...base,
    memory: 210,
    startup: ["worker 3.0.1 started", "loading product catalogue into memory"],
  },
  "ghcr.io/acme/api:1.8.0": {
    ...base,
    healthPath: "/health",
    startup: ["api 1.8.0 listening on :8080"],
    response: '{"products":128,"status":"ok"}',
  },
  "ghcr.io/acme/checkout:4.2.0": {
    ...base,
    healthPath: "/health",
    startup: ["checkout 4.2.0 listening on :8080", "routes: /cart /pay /health"],
    response: '{"service":"checkout","status":"ok"}',
  },
  "ghcr.io/acme/reports:0.9.4": {
    ...base,
    memory: 300,
    cpu: 350,
    startup: ["reports 0.9.4 ready", "next run in 10m"],
  },
  "ghcr.io/acme/frontend:5.0.0": {
    ...base,
    healthPath: "/",
    requiredEnv: [{ name: "API_URL" }],
    startup: ["frontend 5.0.0 listening on :8080"],
    response: "<html><title>Acme shop</title>...</html>",
  },
  "busybox:1.37": {
    ...base,
    port: 0,
    healthPath: "",
    memory: 4,
    cpu: 1,
    startup: [],
  },
};

export function lookupImage(image: string): ImageBehavior | undefined {
  return REGISTRY[image];
}

