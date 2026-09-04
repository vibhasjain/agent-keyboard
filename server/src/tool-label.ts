import { basename, isAbsolute, normalize, relative, sep } from "node:path";

const SECRET_TEXT = /token|key|password|secret|authkey\s*=|authorization|bearer/i;
const SECRET_VALUE = /(?:token|key|password|secret|authkey)\s*[:=]|authorization|bearer/i;

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function filePath(value: unknown, checkoutRoot?: string): string {
  const raw = String(value ?? "").trim().replaceAll("\\", "/");
  if (!raw) return "a file";

  if (isAbsolute(raw) || /^[a-z]:\//i.test(raw)) {
    if (checkoutRoot) {
      const rel = relative(checkoutRoot, raw);
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel;
    }
    return basename(raw) || "a file";
  }

  const clean = normalize(raw.replace(/^\.\//, ""));
  if (clean === ".." || clean.startsWith(`..${sep}`)) return basename(clean) || "a file";
  return clean;
}

function primaryArg(input: Record<string, unknown>): string {
  const keys = ["pattern", "query", "url", "subject", "description", "file_path", "path", "taskId", "prompt"];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }
  return "";
}

/** A secret-safe, useful one-line label shared by live status and history. */
export function toolLabel(block: any, checkoutRoot?: string): string {
  const name = String(block?.name ?? "tool");
  const input = block?.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};

  if (name === "Bash") {
    const raw = String(input.command ?? "");
    if (!raw || SECRET_TEXT.test(raw)) return "ran a command";
    const first = raw.split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ").trim();
    return first ? `$ ${clip(first, 90)}` : "ran a command";
  }

  const path = input.file_path ?? input.path;
  const shownPath = SECRET_VALUE.test(String(path ?? "")) ? "a file" : filePath(path, checkoutRoot);
  if (name === "Read") return `read ${shownPath}`;
  if (name === "Edit" || name === "MultiEdit") return `edited ${shownPath}`;
  if (name === "Write") return `wrote ${shownPath}`;

  const arg = primaryArg(input);
  if (SECRET_TEXT.test(JSON.stringify(input)) || SECRET_TEXT.test(arg)) return name;
  return clip(arg ? `${name} ${arg}` : name, 92);
}
