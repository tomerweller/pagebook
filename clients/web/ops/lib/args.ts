export type ArgType = "string" | "int" | "float" | "bool";

export type ArgSpec<K extends string = string> = {
  flag: string;
  dest: K;
  type?: ArgType;
  default?: unknown;
  required?: boolean;
};

export function parseArgs<T extends Record<string, unknown>>(argv: string[], specs: ArgSpec<keyof T & string>[]): T {
  const byFlag = new Map(specs.map((s) => [s.flag, s]));
  const out: Record<string, unknown> = {};
  for (const s of specs) {
    if (s.default !== undefined) out[s.dest] = s.default;
    else if (s.type === "bool") out[s.dest] = false;
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    let flag = tok;
    let inline: string | undefined;
    const eq = tok.indexOf("=");
    if (tok.startsWith("--") && eq > 2) {
      flag = tok.slice(0, eq);
      inline = tok.slice(eq + 1);
    }
    const spec = byFlag.get(flag);
    if (!spec) throw new Error(`unrecognized argument: ${tok}`);
    if (spec.type === "bool") {
      out[spec.dest] = true;
      continue;
    }
    const raw = inline !== undefined ? inline : argv[++i];
    if (raw === undefined) throw new Error(`argument ${flag} expected a value`);
    if (spec.type === "int") {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`argument ${flag}: invalid int ${raw}`);
      out[spec.dest] = n;
    } else if (spec.type === "float") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`argument ${flag}: invalid float ${raw}`);
      out[spec.dest] = n;
    } else {
      out[spec.dest] = raw;
    }
  }
  for (const s of specs) {
    if (s.required && out[s.dest] === undefined) throw new Error(`missing required argument: ${s.flag}`);
  }
  return out as T;
}
