export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (quote) throw new Error("unterminated quote");
  if (hasToken) tokens.push(current);
  return tokens;
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
  rest: string[];
}

const BOOLEAN_FLAGS = new Set([
  "p", "previous", "it", "i", "t", "A", "all-namespaces", "f", "follow", "w", "watch", "show-labels",
]);

// -p means --previous for logs but --patch for patch.
export function parseArgs(args: string[], booleans: Set<string> = BOOLEAN_FLAGS): ParsedArgs {
  const BOOLEAN_FLAGS = booleans;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      rest = args.slice(i + 1);
      break;
    }
    if (arg.startsWith("--")) {
      const [name, value] = arg.slice(2).split(/=(.*)/s, 2);
      if (value !== undefined) flags[name] = value;
      else if (BOOLEAN_FLAGS.has(name) || i + 1 >= args.length || args[i + 1].startsWith("-")) flags[name] = true;
      else flags[name] = args[++i];
    } else if (arg.startsWith("-") && arg.length > 1) {
      const body = arg.slice(1);
      const eq = body.indexOf("=");
      if (eq > 0) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(body) || i + 1 >= args.length || args[i + 1].startsWith("-")) flags[body] = true;
      else flags[body] = args[++i];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, rest };
}
