// Single source of truth for the home partner-logo area (section-06 partner-logo doc).
// Logos are committed PNGs in src/webview/assets/partners/; the host reads + base64-encodes
// them at runtime and the panel renders <img> + openExternal on click. Config-driven, not
// hardcoded in render logic. Partner logos are for the home area only (no board-vendor
// authorization implied). ASCII filenames (the two Chinese-named files were renamed).
export type Partner = { id: string; name: string; file: string; url: string };

export const PARTNERS: readonly Partner[] = [
  { id: "wiznet", name: "WIZnet", file: "wiznet.png", url: "https://wiznet.io/" },
  { id: "yourcee", name: "YourCee", file: "yourcee.png", url: "https://www.yourcee.com/" },
  { id: "mysentech", name: "MySenTech", file: "mysentech.png", url: "https://mysentech.com/" },
  { id: "freenove", name: "Freenove", file: "freenove.png", url: "https://www.freenove.com/" },
  { id: "cocube", name: "CoCube", file: "cocube.png", url: "https://cocube.cn/cn/" },
];
