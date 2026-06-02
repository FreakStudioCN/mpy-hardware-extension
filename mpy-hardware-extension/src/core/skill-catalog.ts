type SkillSummary = { name: string; description?: string; body_url?: string; body_sha256?: string };

export class SkillCatalog {
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private summaries: SkillSummary[] | null = null;
  private bodies = new Map<string, string>();

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async loadSummaries(): Promise<SkillSummary[]> {
    if (this.summaries) return this.summaries;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/skills`);
      if (!response.ok) return [];
      const body: any = await response.json();
      const summaries = Array.isArray(body.skills) ? body.skills : [];
      this.summaries = summaries;
      return summaries;
    } catch {
      this.summaries = [];
      return [];
    }
  }

  async hasSkill(name: string): Promise<boolean> {
    const summaries = await this.loadSummaries();
    return summaries.some((skill) => skill.name === name);
  }

  async fetchBody(name: string): Promise<string | null> {
    if (this.bodies.has(name)) return this.bodies.get(name)!;
    if (!(await this.hasSkill(name))) return null;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/skills/${encodeURIComponent(name)}`);
      if (!response.ok) return null;
      const body = await response.text();
      this.bodies.set(name, body);
      return body;
    } catch {
      return null;
    }
  }

  async renderCatalog(): Promise<string> {
    const summaries = await this.loadSummaries();
    if (!summaries.length) return "";
    const lines = ["AVAILABLE SKILLS (call load_skill with skill when relevant):"];
    for (const skill of summaries) {
      lines.push(`- ${skill.name}: ${skill.description ?? ""}`.trim());
    }
    return lines.join("\n");
  }

  loadedBody(name: string): string | undefined {
    return this.bodies.get(name);
  }
}
