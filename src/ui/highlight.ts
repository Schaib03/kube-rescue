const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

const RULES: [RegExp, string][] = [
  [/\b(CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|FailedScheduling|Unhealthy|BackOff|Warning|Failed|Error from server[^\n]*|Couldn't connect to server|connection refused|not found)\b/g, "s-bad"],
  [/\b(Pending|ContainerCreating|Waiting)\b/g, "s-warn"],
  [/\b(Running|Normal|successfully rolled out|Ready: +True|Scheduled|Started)\b/g, "s-good"],
];

export function highlight(text: string): string {
  const lines = escapeHtml(text).split("\n");
  return lines
    .map((line, index) => {
      if (index === 0 && /^[A-Z][A-Z()%-]+( {2,}[A-Z][A-Z()%-]+)+/.test(line)) {
        return `<span class="s-head">${line}</span>`;
      }
      let out = line;
      for (const [pattern, cls] of RULES) {
        out = out.replace(pattern, (match) => `<span class="${cls}">${match}</span>`);
      }
      return out;
    })
    .join("\n");
}

export function inlineCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}
