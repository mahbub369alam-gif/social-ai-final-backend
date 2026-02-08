import fs from "fs";
import path from "path";

/**
 * Update (or add) KEY=VALUE in .env file at project root.
 * - Preserves comments + unknown keys.
 * - Writes values safely (wraps in quotes if needed).
 */

const needsQuotes = (v: string) => /\s|#|"|'/g.test(v);

const formatValue = (v: string) => {
  const val = String(v ?? "");
  if (val === "") return "";
  // If already quoted, keep as is.
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) return val;
  if (!needsQuotes(val)) return val;
  // Escape existing quotes
  const escaped = val.replace(/"/g, "\\\"");
  return `"${escaped}"`;
};

export function updateEnvFile(pairs: Record<string, string>, envPath?: string): void {
  const filePath = envPath || path.join(process.cwd(), ".env");
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    // if missing, we'll create it
    content = "";
  }

  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();

  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) return line;

    const key = String(m[1] || "").trim();
    if (!key) return line;
    if (!(key in pairs)) return line;

    seen.add(key);
    const v = formatValue(String(pairs[key] ?? ""));
    return `${key}=${v}`;
  });

  for (const [k, v] of Object.entries(pairs)) {
    if (seen.has(k)) continue;
    out.push(`${k}=${formatValue(String(v ?? ""))}`);
  }

  fs.writeFileSync(filePath, out.join("\n"), "utf8");
}
