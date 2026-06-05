import json
import logging
import re
from pathlib import Path
from typing import Any

from app.schema_validate import validate_driver_context

logger = logging.getLogger(__name__)


def safe_context_filename(name: str, version: str) -> str:
    """Filesystem-safe driver-context filename built from an (untrusted upstream)
    package name/version. Path separators and other unexpected characters collapse
    to '_' so a malicious name can't traverse out of the driver_context/ dir."""
    slug = re.sub(r"[^A-Za-z0-9._-]", "_", f"{name}-{version}")
    return f"{slug}.json"


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
            # Honest split: only generatable/verified packages can have code generated;
            # the rest are install-only. Surfaced so UIs don't imply the whole catalog
            # is code-genable.
            "generatable_count": counts.get("generatable", 0) + counts.get("verified", 0),
            "support_level_counts": counts,
            "cached": True,
        }

    def search(self, query: str = "", capabilities: list[str] | None = None, limit: int = 10) -> list[dict[str, Any]]:
        return [_public_hit(hit) for hit in self._ranked(query, capabilities, limit)]

    def _ranked(self, query: str = "", capabilities: list[str] | None = None, limit: int = 10) -> list[dict[str, Any]]:
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
        candidates = self._ranked(intent, primary_capabilities, limit=10)
        family = board_family(board_id)
        for candidate in candidates:
            candidate["score"] += board_match_weight(candidate.get("chips", "all"), family)
            if family and str(candidate.get("chips", "all")).lower() not in {"", "all"} and family in str(candidate.get("chips", "")).lower():
                candidate["reason"] = "board_family_match"
        candidates = sorted(candidates, key=lambda hit: (-hit["score"], -hit["confidence"], hit["name"]))
        selected = candidates[0] if candidates else None
        return {
            "candidates": [_public_hit(candidate) for candidate in candidates],
            "selected": _public_hit(selected) if selected else None,
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
            base = (ROOT / "content" / "packages").resolve()
            context_path = (base / record["driver_context_ref"]).resolve()
            # Contain the ref to content/packages: a traversing ref (e.g. from a
            # poisoned ingest) must not read files outside the package tree.
            if context_path.is_relative_to(base) and context_path.exists():
                context = json.loads(context_path.read_text(encoding="utf-8"))
        if not context:
            raise ValueError("driver_context_missing")
        # Soft serve-time check: ingest already hard-gates, so a failure here means
        # a schema bump landed ahead of a content regen. Log it but still serve —
        # a schema nit must not break codegen (and it is NOT a 404 "not found").
        errors = validate_driver_context(context)
        if errors:
            logger.warning("driver_context schema-invalid for %s@%s: %s", name, version, "; ".join(errors[:3]))
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


def _public_hit(hit: dict[str, Any]) -> dict[str, Any]:
    """Strip internal-only fields (e.g. the confidence ranking score) from a
    search/resolve hit before it crosses the API boundary."""
    return {key: value for key, value in hit.items() if key not in INTERNAL_FIELDS}


def support_weight(level: str) -> float:
    return {
        "verified": 4.0,
        "generatable": 3.0,
        "installable": 2.0,
        "discoverable": 1.0,
        "experimental": 0.0,
    }.get(level, 0.0)


# GraftSense (rich AST-extracted contexts) wins ties over uPyPI when the same chip
# is ingested from both; curated stays highest. Used only as a tiebreaker after
# support_level / confidence / having a driver_context.
SOURCE_PRIORITY = {"curated": 3, "graftsense": 2, "upypi": 1}


def canonical_chip_id(name: str) -> str:
    """Cross-source identity for one physical device, so the same chip ingested
    from GraftSense (`bmp280_driver`) and uPyPI (`bmp280`) collapse to a single
    catalog entry. Deliberately conservative — lowercase, '-'->'_', strip a
    trailing '_driver' — so near-names (bmp280 vs bmp390, ssd1306 vs ssd1327)
    stay distinct."""
    slug = name.strip().lower().replace("-", "_")
    if slug.endswith("_driver"):
        slug = slug[: -len("_driver")]
    return slug


def version_key(version: str) -> tuple[tuple[int, Any], ...]:
    """Sortable key for a version string: numeric segments compare as ints,
    everything else as lowercase strings (so 1.0.10 > 1.0.2)."""
    parts: list[tuple[int, Any]] = []
    for token in re.split(r"([0-9]+)", str(version)):
        if not token or token in {".", "-", "_"}:
            continue
        for part in re.split(r"[._-]+", token):
            if not part:
                continue
            parts.append((0, int(part)) if part.isdigit() else (1, part.lower()))
    return tuple(parts)


def _chip_strength(record: dict[str, Any]) -> tuple:
    """Total ordering used to pick the surviving record within a chip group.
    Strongest support_level first, then confidence, then having a driver_context,
    then source priority, then newest version, then name (final deterministic
    tiebreak)."""
    return (
        support_weight(record.get("support_level", "discoverable")),
        float(record.get("confidence", 0.0)),
        1 if (record.get("driver_context_ref") or record.get("driver_context")) else 0,
        SOURCE_PRIORITY.get(record.get("source", ""), 0),
        version_key(record.get("version", "")),
        record.get("name", ""),
    )


def dedupe_by_chip(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse records describing the same physical chip (canonical_chip_id) to the
    single strongest one (see _chip_strength). Losing duplicates are dropped — group
    order is preserved by first appearance so the result is deterministic."""
    groups: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for record in records:
        cid = canonical_chip_id(record["name"])
        if cid not in groups:
            groups[cid] = []
            order.append(cid)
        groups[cid].append(record)
    return [max(groups[cid], key=_chip_strength) for cid in order]


def primary_resolution_capabilities(capabilities: list[str]) -> list[str]:
    sensing = [capability for capability in capabilities if capability in {"temperature_sensing", "humidity_sensing"}]
    if sensing:
        return sensing
    return capabilities


def board_family(board_id: str) -> str:
    value = (board_id or "").lower()
    for family in ("esp32", "rp2040", "pico"):
        if family in value:
            return "rp2040" if family == "pico" else family
    return ""


def board_match_weight(chips: str, family: str) -> float:
    chip_text = str(chips or "all").lower()
    if not family or chip_text in {"", "all"}:
        return 0.0
    if family in chip_text:
        return 2.0
    return -5.0


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
# explicit capabilities list. Substring match against name + description. Keyword
# sets are tuned against the full upypi catalog (200+ packages): chip part numbers
# in the package name are the strongest signal, since most descriptions are the
# boilerplate "A MicroPython library to control <name>". A package may match
# several capabilities (e.g. si1145 senses both light and UV) — all are kept.
CAPABILITY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("temperature_sensing", ("temperature", "aht20", "aht21", "dht", "bmp280", "bme280", "ds18b20", "ds18x20", "ds18", "my18e20", "thermo", "mlx90614", "mcp9808", "lm75", "scd4")),
    ("humidity_sensing", ("humid", "aht20", "aht21", "dht", "bme280", "moisture", "soil", "scd4")),
    ("pressure_sensing", ("pressure", "barometer", "bmp280", "bme280", "bmp390", "bmp581", "dps310", "icp10111", "mpl3115", "ms5611", "ms5803")),
    ("display_text", ("oled", "ssd1306", "ssd1327", "ssd1683", "display", "lcd", "lcm1602", "menu", "screen", "sh1106", "sh1107", "st7789", "st7735", "ht16k33", "tm1637", "eink", "e-ink", "epaper", "e-paper")),
    ("digital_output", ("led", "relay", "neopixel", "ws2812", "pixel", "piranha", "mcp23017", "pcf8574", "pcf8575", "opto", "mosfet")),
    ("digital_input", ("button", "joystick", "rotary", "encoder", "limit switch", "wheelswitch", "hall", "keypad", "keys")),
    ("motion_sensing", ("mpu6050", "mpu9250", "pir", "motion", "gyro", "accelerometer", "imu", "mems", "adxl345", "bma220", "bma400", "kx132", "mma7660", "mma8451", "mma8452", "h3lis", "lis2dh", "lis3dh", "lsm6", "icm20", "tilt")),
    ("distance_sensing", ("ultrasonic", "hcsr04", "hc-sr04", "distance", "rcwl", "tof", "vl53", "gp2y0", "proximity")),
    ("color_sensing", ("tcs34725", "tcs3472", "color", "veml6040", "as7341", "spectral")),
    ("analog_input", ("adc", "ads1115", "ads1015", "ads1219", "analog", "mcp3421", "cs1237", "pcf8591", "potentiometer")),
    ("analog_output", ("dac", "mcp4725", "mcp4728", "ds3502", "digipot")),
    ("servo_control", ("servo",)),
    ("touch_sensing", ("mpr121", "touch", "capacitive", "gt911")),
    ("gas_sensing", ("gas", "co2", "eco2", "voc", "air quality", "mq2", "mq135", "mqx", "mgx", "ccs811", "ags02", "sgp40", "sgp30", "ens160", "mics", "pms5003", "pms7003", "particulate")),
    ("timekeeping", ("rtc", "ds1307", "ds1302", "ds3231", "pcf8563", "pcf8523")),
    ("magnetic_sensing", ("magnet", "magneto", "compass", "geomagnetic", "qmc5883", "hmc5883", "bmm150", "lis2mdl", "lis3mdl", "mlx90393", "mmc5603", "mmc5983", "rm3100", "hscdtd", "as5600")),
    ("light_sensing", ("illuminance", "lux", "ambient light", "luminosity", "photoresistor", "bh1750", "tsl2561", "opt3001", "max44009", "veml7700", "ltr390", "isl29125", "si1145", "gl5516")),
    ("uv_sensing", ("ultraviolet", "uva", "uvb", "veml6075", "ltr390", "si1145", "guva", "s12sd")),
    ("current_sensing", ("current", "ina219", "ina226", "shunt", "ammeter", "power monitor")),
    ("motor_control", ("motor", "stepper", "fan_pwm")),
    ("weight_sensing", ("load cell", "loadcell", "weight", "hx711", "cs1237", "strain")),
    ("heart_rate_sensing", ("heart rate", "heartrate", "pulse oximeter", "spo2", "max30100", "max30102")),
    ("sound_sensing", ("microphone", "max9814")),
    ("audio_output", ("buzzer", "speaker", "mp3", "tts", "jq6500", "kt403a", "dy_sv19t", "snr9816")),
]


def infer_capabilities(raw: dict[str, Any]) -> list[str]:
    text = " ".join(str(raw.get(key, "")) for key in ("name", "description")).lower()
    capabilities: list[str] = []
    for capability, keywords in CAPABILITY_KEYWORDS:
        if capability not in capabilities and any(keyword in text for keyword in keywords):
            capabilities.append(capability)
    return capabilities
