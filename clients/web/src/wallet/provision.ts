import type { CreditAsset } from "./account";

export type ProvisionSource = "generate" | "seed" | "import";

export type ProvisionStep = { op: "fund" } | { op: "trust"; asset: CreditAsset };

export type ProvisionPlanInput = {
  source: ProvisionSource;
  accountExists: boolean;
  missing: CreditAsset[];
};

export function planProvision(input: ProvisionPlanInput): ProvisionStep[] {
  if (input.source === "import") return [];
  const steps: ProvisionStep[] = [];
  if (!input.accountExists) steps.push({ op: "fund" });
  for (const asset of input.missing) steps.push({ op: "trust", asset });
  return steps;
}

export function missingCredits(needed: CreditAsset[], have: { asset: CreditAsset; exists: boolean }[]): CreditAsset[] {
  return needed.filter((a) => !have.some((t) => t.exists && t.asset.code === a.code && t.asset.issuer === a.issuer));
}
