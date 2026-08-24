declare module "node:child_process" {
  export function spawnSync(
    command: string,
    args: string[],
    options: { encoding: string },
  ): { stdout: string; stderr: string; status: number | null; error?: { code?: string; message: string } };
}

declare module "node:fs" {
  export function appendFileSync(path: string | number, data: string): void;
  export function openSync(path: string, flags: string): number;
  export function closeSync(fd: number): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string, encoding: string): string;
  export function renameSync(a: string, b: string): void;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function dirname(p: string): string;
  export function join(...p: string[]): string;
  export function resolve(...p: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(u: string | URL): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  on(event: string, fn: (signal?: string) => void): void;
  stderr: { write(s: string): void };
  exit(code: number): never;
};
