from __future__ import annotations

import re
from typing import Any


def extract_driver_context(package: dict[str, Any], readme: str, source: str) -> dict[str, Any]:
    combined = f"{readme}\n{source}"
    import_names = sorted(set(re.findall(r"(?:import|from)\s+([a-zA-Z_][\w]*)", combined)))
    constructors = sorted(set(re.findall(r"([A-Z][A-Za-z0-9_]+\(\s*i2c\s*\))", combined)))
    read_properties = []
    if re.search(r"def\s+temperature\b|\.temperature\b", combined):
        read_properties.append("temperature")
    if re.search(r"def\s+relative_humidity\b|\.relative_humidity\b", combined):
        read_properties.append("relative_humidity")
    context = {
        "import_names": import_names,
        "constructors": constructors,
        "read_methods": [],
        "read_properties": read_properties,
        "bus": ["i2c"] if "i2c" in combined.lower() else [],
        "pin_roles": ["i2c_sda", "i2c_scl"] if "i2c" in combined.lower() else [],
        "install": {"method": "mpremote mip install", "url": package.get("package_json_url", "")},
        "examples": extract_examples(readme),
        "known_issues": [],
        "evidence_refs": [{"type": "readme", "path": "aht20-readme.md"}, {"type": "source", "path": "aht20-source.py"}],
        "confidence": 0.75,
    }
    context["support_level"] = evaluate_support_level(package, context, requested_level="generatable")
    return context


def evaluate_support_level(
    package: dict[str, Any],
    context: dict[str, Any],
    requested_level: str = "discoverable",
    contract_evidence: bool = False,
    smoke_evidence: bool = False,
) -> str:
    has_install = bool(package.get("package_json_url"))
    has_api_shape = bool(context.get("evidence_refs")) and bool(context.get("constructors")) and bool(context.get("read_properties") or context.get("read_methods"))
    if requested_level == "verified":
      if has_install and has_api_shape and contract_evidence and smoke_evidence:
          return "verified"
      if has_install and has_api_shape:
          return "generatable"
    if has_install and has_api_shape:
        return "generatable"
    if has_install:
        return "installable"
    return "discoverable"


def extract_examples(readme: str) -> list[str]:
    blocks = re.findall(r"```(?:python)?\s*(.*?)```", readme, flags=re.DOTALL)
    return [block.strip() for block in blocks if block.strip()]
