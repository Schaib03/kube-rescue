export function parseCpu(text: string): number {
  const value = text.trim();
  if (/^\d+m$/.test(value)) return Number.parseInt(value, 10);
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number.parseFloat(value) * 1000);
  throw new Error(`invalid cpu quantity "${text}"`);
}

export function parseMemory(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|K|M|G)?$/.exec(text.trim());
  if (!match) throw new Error(`invalid memory quantity "${text}"`);
  const amount = Number.parseFloat(match[1]);
  const factors: Record<string, number> = {
    Ki: 1 / 1024,
    Mi: 1,
    Gi: 1024,
    K: 1000 / 1024 / 1024,
    M: 1_000_000 / 1024 / 1024,
    G: 1_000_000_000 / 1024 / 1024,
  };
  const unit = match[2];
  if (!unit) return Math.round(amount / 1024 / 1024);
  return Math.round(amount * factors[unit]);
}

export function formatCpu(millicores: number | undefined): string {
  if (millicores === undefined) return "<none>";
  return millicores % 1000 === 0 ? String(millicores / 1000) : `${millicores}m`;
}

export function formatMemory(mebibytes: number | undefined): string {
  if (mebibytes === undefined) return "<none>";
  return mebibytes % 1024 === 0 ? `${mebibytes / 1024}Gi` : `${mebibytes}Mi`;
}
