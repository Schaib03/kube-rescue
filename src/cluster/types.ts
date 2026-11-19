export type Labels = Record<string, string>;

export interface Quantity {
  cpu?: number; // millicores
  memory?: number; // MiB
}

export interface Probe {
  path: string;
  port: number;
}

export interface Container {
  name: string;
  image: string;
  env: Record<string, string>;
  containerPort?: number;
  readinessProbe?: Probe;
  requests: Quantity;
  limits: Quantity;
}

export interface PodTemplate {
  labels: Labels;
  containers: Container[];
}

export interface Deployment {
  name: string;
  replicas: number;
  selector: Labels;
  template: PodTemplate;
  revision: number;
  history: { revision: number; template: PodTemplate; cause: string }[];
  changeCause: string;
  updatedAt: number;
}

export interface Service {
  name: string;
  selector: Labels;
  port: number;
  targetPort: number;
  clusterIP: string;
}

export interface Node {
  name: string;
  cpu: number;
  memory: number;
}

export interface Cluster {
  namespace: string;
  startedAt: number;
  ageMinutes: number;
  deployments: Deployment[];
  services: Service[];
  nodes: Node[];
  configMaps: { name: string; data: Record<string, string> }[];
}

export type PodStatus =
  | "Running"
  | "ContainerCreating"
  | "CrashLoopBackOff"
  | "ImagePullBackOff"
  | "Pending";

export interface KEvent {
  type: "Normal" | "Warning";
  reason: string;
  object: string;
  message: string;
  ageSeconds: number;
}

export interface PodView {
  name: string;
  deployment: string;
  labels: Labels;
  container: Container;
  node: string | null;
  ip: string | null;
  status: PodStatus;
  ready: boolean;
  restarts: number;
  ageSeconds: number;
  lastTermination?: { reason: string; exitCode: number };
  waitingReason?: string;
  logs: string[];
  previousLogs: string[];
  events: KEvent[];
  memoryUsage: number;
  cpuUsage: number;
}
