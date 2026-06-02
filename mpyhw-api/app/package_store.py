import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]

NORMALIZED_PACKAGE_FIELDS = [
    "name",
    "version",
    "source",
    "description",
    "author",
    "license",
    "chips",
    "fw",
    "deps",
    "urls",
    "package_json_url",
    "readme_url",
    "repository_url",
    "capabilities",
    "support_level",
    "cached",
]

INTERNAL_FIELDS = {"score_base", "reason_rules", "driver_context_ref", "evidence_refs", "driver_context", "bus", "confidence"}


class PackageStore:
    def __init__(self, records: list[dict[str, Any]]):
        self.records = records

    @classmethod
    def default(cls) -> "PackageStore":
        package_dir = ROOT / "content" / "packages"
        curated = json.loads((package_dir / "curated-driver-contexts.json").read_text(encoding="utf-8"))
        # Fill normalized defaults on every record so downstream index()/search()/
        # _hit() never KeyError on a partial (ingested) row; records missing the
        # required name/version are dropped rather than crashing the store.
        records = [merged for record in curated if (merged := _with_defaults(record))]
        index_path = package_dir / "package_index.json"
        if index_path.exists():
            seen = {(record["name"], record["version"]) for record in records}
            for record in json.loads(index_path.read_text(encoding="utf-8")):
                merged = _with_defaults(record)
                if merged is None:
                    continue
                key = (merged["name"], merged["version"])
                if key not in seen:
                    records.append(merged)
                    seen.add(key)
        return cls(records)

    def index(self) -> dict[str, Any]:
        counts: dict[str, int] = {}
        for record in self.records:
            counts[record["support_level"]] = counts.get(record["support_level"], 0) + 1
        return {
            "version": "phase1-curated",
            "sources": [{"source": "curated", "package_count": len(self.records), "last_synced_at": "2026-06-01T00:00:00Z"}],
            "total_packages": len(self.records),
            "support_level_counts": counts,
            "cached": True,
        }

    def search(self, query: str = "", capabilities: list[str] | None = None, limit: int = 10) -> list[dict[str, Any]]:
        capabilities = capabilities or []
        stop_words = {"the", "and", "when", "with", "over", "turn", "on", "off", "read", "show", "is"}
        terms = {term for term in query.lower().replace("_", " ").split() if len(term) >= 3 and term not in stop_words}
        hits: list[dict[str, Any]] = []
        for record in self.records:
            score = 0.0
            record_caps = set(record.get("capabilities", []))
            score += 10.0 * len(record_caps.intersection(capabilities))
            if capabilities and not record_caps.intersection(capabilities):
                continue
            score += support_weight(record["support_level"])
            score += float(record.get("confidence", 0.0))
            haystack = " ".join([record["name"], record.get("description", ""), " ".join(record_caps)]).lower()
            score += 0.25 * sum(1 for term in terms if term and term in haystack)
            if score > 0 or not query and not capabilities:
                hit = self._hit(record)
                hit["score"] = score
                hit["reason"] = "capability_match" if score else "listed"
                hits.append(hit)
        return sorted(hits, key=lambda hit: (-hit["score"], -hit["confidence"], hit["name"]))[:limit]

    def resolve(self, intent: str, capabilities: list[str], board_id: str) -> dict[str, Any]:
        primary_capabilities = primary_resolution_capabilities(capabilities)
        candidates = self.search(intent, primary_capabilities, limit=10)
        selected = candidates[0] if candidates else None
        return {
            "candidates": candidates,
            "selected": selected,
            "needs_user_choice": selected is None,
            "questions": [] if selected else ["No package candidate matched the requested capabilities."],
        }

    def get_record(self, name: str, version: str) -> dict[str, Any] | None:
        return next((record for record in self.records if record["name"] == name and record["version"] == version), None)

    def get_driver_context(self, name: str, version: str) -> dict[str, Any]:
        record = self.get_record(name, version)
        if record is None:
            raise KeyError("package_not_found")
        context = record.get("driver_context")
        if not context and record.get("driver_context_ref"):
            context_path = ROOT / "content" / "packages" / record["driver_context_ref"]
            if context_path.exists():
                context = json.loads(context_path.read_text(encoding="utf-8"))
        if not context:
            raise ValueError("driver_context_missing")
        return {"package": self._package_record(record), **context}

    def _package_record(self, record: dict[str, Any]) -> dict[str, Any]:
        return normalize_record(record)

    def _hit(self, record: dict[str, Any]) -> dict[str, Any]:
        return {
            "name": record["name"],
            "version": record["version"],
            "source": record["source"],
            "package_json_url": record["package_json_url"],
            "description": record.get("description"),
            "capabilities": record["capabilities"],
            "chips": record.get("chips", "all"),
            "fw": record.get("fw", "all"),
            "support_level": record["support_level"],
            "confidence": record.get("confidence", 0.0),
            "score": 0.0,
            "reason": "",
        }


def support_weight(level: str) -> float:
    return {
        "verified": 4.0,
        "generatable": 3.0,
        "installable": 2.0,
        "discoverable": 1.0,
        "experimental": 0.0,
    }.get(level, 0.0)


def primary_resolution_capabilities(capabilities: list[str]) -> list[str]:
    sensing = [capability for capability in capabilities if capability in {"temperature_sensing", "humidity_sensing"}]
    if sensing:
        return sensing
    return capabilities


def _with_defaults(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Merge normalized field defaults over a raw record while preserving extra
    keys (driver_context_ref, driver_context, etc.). Returns None when the record
    is missing the required name/version."""
    try:
        normalized = normalize_record(raw)
    except ValueError:
        return None
    return {**raw, **normalized}


def normalize_record(raw: dict[str, Any]) -> dict[str, Any]:
    name = raw.get("name")
    version = raw.get("version")
    if not name or not version:
        raise ValueError("missing required package fields")
    normalized = {
        "name": name,
        "version": version,
        "source": raw.get("source", "curated"),
        "description": raw.get("description", ""),
        "author": raw.get("author", ""),
        "license": raw.get("license", ""),
        "chips": raw.get("chips", "all"),
        "fw": raw.get("fw", "all"),
        "deps": raw.get("deps", []),
        "urls": raw.get("urls", []),
        "package_json_url": raw.get("package_json_url", ""),
        "readme_url": raw.get("readme_url"),
        "repository_url": raw.get("repository_url"),
        "capabilities": raw.get("capabilities") or infer_capabilities(raw),
        "support_level": raw.get("support_level", "discoverable"),
        "cached": raw.get("cached", True),
    }
    return normalized


# Keyword -> capability inference for ingested packages whose JSON carries no
# explicit capabilities list. Substring match against name + description. Keeps
# the original four capabilities and extends to the rest of the upypi catalog.
CAPABILITY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("temperature_sensing", ("temp", "aht20", "aht21", "dht", "bmp280", "bme280", "ds18b20", "ds18x20", "thermo")),
    ("humidity_sensing", ("humid", "aht20", "aht21", "dht", "bme280")),
    ("pressure_sensing", ("pressure", "bmp280", "bme280", "barometer")),
    ("display_text", ("oled", "ssd1306", "display", "lcd", "menu", "screen")),
    ("digital_output", ("led", "relay", "neopixel", "ws2812", "pixel", "piranha")),
    ("motion_sensing", ("mpu6050", "pir", "motion", "gyro", "accel", "imu", "mpu9250")),
    ("distance_sensing", ("ultrasonic", "hcsr04", "hc-sr04", "distance", "rcwl", "tof", "vl53")),
    ("color_sensing", ("tcs34725", "color")),
    ("analog_input", ("adc", "ads1115", "ads1015", "analog")),
    ("servo_control", ("servo",)),
    ("touch_sensing", ("mpr121", "touch", "capacitive")),
    ("gas_sensing", ("gas", "co2", "mq2", "mq135", "voc")),
    ("timekeeping", ("rtc", "ds1307", "ds1302", "ds3231")),
]


def infer_capabilities(raw: dict[str, Any]) -> list[str]:
    text = " ".join(str(raw.get(key, "")) for key in ("name", "description")).lower()
    capabilities: list[str] = []
    for capability, keywords in CAPABILITY_KEYWORDS:
        if capability not in capabilities and any(keyword in text for keyword in keywords):
            capabilities.append(capability)
    return capabilities
