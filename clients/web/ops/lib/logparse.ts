export type OpsLogRecord = {
  t?: number;
  action?: string;
  outcome?: string;
  tx?: string;
  role?: string;
  acct?: string;
  [k: string]: unknown;
};

export function parseLogLines(text: string): OpsLogRecord[] {
  const out: OpsLogRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as OpsLogRecord);
    } catch {
      continue;
    }
  }
  return out;
}

export function clipDetail(detail: string, max = 600): string {
  if (detail.length <= max) return detail;
  return detail.slice(0, 400) + " ... " + detail.slice(-200);
}