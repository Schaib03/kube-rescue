export function age(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m${s % 60}s`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] + 3)))
      .join("")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

type Yaml = string | number | boolean | null | undefined | Yaml[] | { [key: string]: Yaml };

function scalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  if (
    value === "" ||
    /^[\d.]+$/.test(value) ||
    /^(true|false|null|yes|no|on|off)$/i.test(value) ||
    /: |\s#|^[-?:,[\]{}#&*!|>'"%@`]|^\s|\s$/.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

export function toYaml(value: Yaml, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const body = toYaml(item, indent + 2).trimStart();
          return `${pad}- ${body}`;
        }
        return `${pad}- ${scalar(item as string)}`;
      })
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([key, v]) => {
        if (v !== null && typeof v === "object") {
          const empty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
          if (empty) return `${pad}${key}: ${Array.isArray(v) ? "[]" : "{}"}`;
          const nested = Array.isArray(v) ? toYaml(v, indent) : toYaml(v, indent + 2);
          return `${pad}${key}:\n${nested}`;
        }
        return `${pad}${key}: ${scalar(v as string)}`;
      })
      .join("\n");
  }
  return `${pad}${scalar(value as string)}`;
}
