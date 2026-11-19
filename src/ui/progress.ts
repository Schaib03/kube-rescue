const KEY = "kube-rescue/progress/v1";

export type Progress = Record<string, number>;

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Progress) : {};
  } catch {
    return {};
  }
}

export function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // Private mode or blocked storage: progress just isn't remembered.
  }
}

export function starsFor(commands: number, par: number, hints: number): number {
  let stars = commands <= par ? 3 : commands <= Math.ceil(par * 1.75) ? 2 : 1;
  if (hints >= 3) stars = Math.min(stars, 1);
  else if (hints === 2) stars = Math.min(stars, 2);
  return stars;
}
