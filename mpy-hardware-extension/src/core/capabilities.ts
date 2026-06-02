export type Capability = "temperature_sensing" | "humidity_sensing" | "digital_output" | "display_text";

const KEYWORDS: Array<[Capability, string[]]> = [
  ["temperature_sensing", ["temperature", "temp", "hot", "heat", "over 30", "above 30", "温度", "超过30", "过30", "30度"]],
  ["humidity_sensing", ["humidity", "humid", "moisture", "湿度"]],
  ["digital_output", ["led", "light", "lamp", "turn on", "turn off", "blink", "红灯", "亮灯", "亮红灯"]],
  ["display_text", ["display", "screen", "oled", "ssd1306", "show text", "屏幕", "显示"]],
];

export function extractCapabilities(intent: string): Capability[] {
  const text = intent.toLowerCase();
  const capabilities: Capability[] = [];
  for (const [capability, keywords] of KEYWORDS) {
    if (keywords.some((keyword) => matchesKeyword(text, keyword))) {
      capabilities.push(capability);
    }
  }
  return capabilities;
}

function matchesKeyword(text: string, keyword: string): boolean {
  if (/^[a-z0-9 ]+$/.test(keyword)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}($|[^a-z0-9])`);
    return pattern.test(text);
  }
  return text.includes(keyword);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
