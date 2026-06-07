type PhaseProfile = {
  phase: string;
  goal?: string;
  execution_mode?: string;
  decision_rules?: string[];
  tools?: string[];
  inputs?: string[];
  outputs?: string[];
  failure_strategy?: string[];
};

export class SkillCatalog {
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private profiles = new Map<string, PhaseProfile>();

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async fetchPhaseProfile(phase: string): Promise<PhaseProfile | null> {
    if (this.profiles.has(phase)) return this.profiles.get(phase)!;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/phase-profiles/${encodeURIComponent(phase)}`);
      if (!response.ok) return null;
      const profile: any = await response.json();
      this.profiles.set(phase, profile);
      return profile;
    } catch {
      return null;
    }
  }
}
