import * as StellarSdk from "@stellar/stellar-sdk";

export const STORAGE_KEY = "pagebook.wallet.v1";
export const SEED_NAME = "(seed)";

export type Identity = {
  name: string;
  publicKey: string;
  secret: string;
};

export type StoredWallet = {
  identities: Identity[];
  active: string | null;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

export function deriveFromSeed(seed: string): Identity {
  const digest = StellarSdk.hash(new TextEncoder().encode(seed));
  const kp = StellarSdk.Keypair.fromRawEd25519Seed(digest);
  return { name: SEED_NAME, publicKey: kp.publicKey(), secret: kp.secret() };
}

export function identityFromSecret(secret: string, name: string): Identity {
  const kp = StellarSdk.Keypair.fromSecret(secret.trim());
  return { name, publicKey: kp.publicKey(), secret: kp.secret() };
}

function emptyStore(): StoredWallet {
  return { identities: [], active: null };
}

function parseStore(raw: string | null): StoredWallet {
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyStore();
    const rec = parsed as Record<string, unknown>;
    const identities = Array.isArray(rec.identities)
      ? rec.identities.filter((id): id is Identity => {
          if (!id || typeof id !== "object") return false;
          const row = id as Record<string, unknown>;
          return typeof row.name === "string" && typeof row.publicKey === "string" && typeof row.secret === "string";
        })
      : [];
    const active = typeof rec.active === "string" ? rec.active : null;
    return { identities, active };
  } catch {
    return emptyStore();
  }
}

export class Keystore {
  private ephemeral: Identity | null = null;
  private ephemeralActive = false;

  constructor(private readonly storage: StorageLike) {}

  private read(): StoredWallet {
    return parseStore(this.storage.getItem(STORAGE_KEY));
  }

  private write(state: StoredWallet): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  list(): Identity[] {
    const ids = this.read().identities;
    return this.ephemeral ? [this.ephemeral, ...ids] : ids;
  }

  active(): Identity | null {
    if (this.ephemeralActive && this.ephemeral) return this.ephemeral;
    const s = this.read();
    if (!s.active) return null;
    return s.identities.find((i) => i.name === s.active) ?? null;
  }

  select(name: string): void {
    if (this.ephemeral && name === this.ephemeral.name) {
      this.ephemeralActive = true;
      return;
    }
    const s = this.read();
    if (!s.identities.some((i) => i.name === name)) throw new Error("unknown identity");
    this.ephemeralActive = false;
    this.write({ ...s, active: name });
  }

  clearActive(): void {
    this.ephemeralActive = false;
    const s = this.read();
    this.write({ ...s, active: null });
  }

  private uniqueName(wanted: string): string {
    const taken = new Set(this.list().map((i) => i.name));
    if (!taken.has(wanted)) return wanted;
    for (let n = 2; n < 1000; n++) {
      const cand = `${wanted} ${n}`;
      if (!taken.has(cand)) return cand;
    }
    throw new Error("could not name identity");
  }

  private nextDefaultName(): string {
    const taken = new Set(this.list().map((i) => i.name));
    for (let n = 1; n < 1000; n++) {
      const cand = `key ${n}`;
      if (!taken.has(cand)) return cand;
    }
    throw new Error("could not name identity");
  }

  create(name?: string): Identity {
    const kp = StellarSdk.Keypair.random();
    const id: Identity = {
      name: this.uniqueName(name || this.nextDefaultName()),
      publicKey: kp.publicKey(),
      secret: kp.secret(),
    };
    this.persist(id);
    this.select(id.name);
    return id;
  }

  importSecret(secret: string, name?: string): Identity {
    const id = identityFromSecret(secret, this.uniqueName(name || this.nextDefaultName()));
    this.persist(id);
    this.select(id.name);
    return id;
  }

  activateSeed(seed: string): Identity {
    this.ephemeral = deriveFromSeed(seed);
    this.ephemeralActive = true;
    return this.ephemeral;
  }

  saveEphemeral(name?: string): Identity {
    if (!this.ephemeral) throw new Error("no seed identity");
    const id: Identity = {
      ...this.ephemeral,
      name: this.uniqueName(name || this.nextDefaultName()),
    };
    this.persist(id);
    this.ephemeral = null;
    this.ephemeralActive = false;
    this.select(id.name);
    return id;
  }

  isEphemeralActive(): boolean {
    return this.ephemeralActive && this.ephemeral != null;
  }

  rename(oldName: string, newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error("name required");
    if (this.ephemeral && oldName === this.ephemeral.name) {
      throw new Error("save the seed identity before renaming");
    }
    const s = this.read();
    const idx = s.identities.findIndex((i) => i.name === oldName);
    if (idx < 0) throw new Error("unknown identity");
    const name = this.uniqueName(trimmed);
    const next = s.identities.map((i, iAt) => (iAt === idx ? { ...i, name } : i));
    this.write({ identities: next, active: s.active === oldName ? name : s.active });
  }

  remove(name: string): void {
    if (this.ephemeral && name === this.ephemeral.name) {
      this.ephemeral = null;
      this.ephemeralActive = false;
      return;
    }
    const s = this.read();
    const identities = s.identities.filter((i) => i.name !== name);
    const active = s.active === name ? (identities[0]?.name ?? null) : s.active;
    this.write({ identities, active });
  }

  private persist(id: Identity): void {
    const s = this.read();
    this.write({ identities: [...s.identities, id], active: id.name });
  }
}
