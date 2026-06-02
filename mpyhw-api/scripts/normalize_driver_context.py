from __future__ import annotations

import re
from typing import Any


# MicroPython stdlib / framework modules that are never the driver's own module.
STDLIB_MODULES = {
    "machine", "time", "math", "struct", "ustruct", "utime", "framebuf",
    "micropython", "json", "ujson", "os", "uos", "sys", "gc", "array", "_thread", "rp2",
}


def extract_driver_context(
    package: dict[str, Any], readme: str, source: str, module_name: str | None = None
) -> dict[str, Any]:
    combined = f"{readme}\n{source}"
    # Capture only the module (the X in `import X` / `from X import ...`), not the
    # imported symbols, so import_names stays a list of real modules.
    modules = {
        (frm or imp).split(".")[0]
        for frm, imp in re.findall(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", combined, re.MULTILINE)
        if (frm or imp)
    }
    raw_imports = sorted(modules)
    if module_name:
        # Live ingest: the driver's own module must be the import codegen uses
        # (import_names[0]); drop stdlib so the module isn't shadowed by `machine`.
        others = [name for name in raw_imports if name != module_name and name not in STDLIB_MODULES]
        import_names = [module_name, *others]
    else:
        import_names = raw_imports

    # Single-arg `Xxx(i2c)` plus any class whose __init__ takes an i2c argument
    # (real drivers use multi-arg constructors like SSD1306_I2C(i2c, addr, ...)).
    constructors = set(re.findall(r"([A-Z][A-Za-z0-9_]+\(\s*i2c\s*\))", combined))
    for match in re.finditer(r"class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:(.*?)(?=\nclass\s|\Z)", source, re.DOTALL):
        class_name, body = match.group(1), match.group(2)
        init = re.search(r"def\s+__init__\s*\(([^)]*)\)", body)
        if init and re.search(r"(?:^|,)\s*i2c\b", init.group(1)):
            constructors.add(f"{class_name}(i2c)")
    constructors = sorted(constructors)

    read_properties = []
    if re.search(r"def\s+temperature\b|\.temperature\b", combined):
        read_properties.append("temperature")
    if re.search(r"def\s+relative_humidity\b|\.relative_humidity\b", combined):
        read_properties.append("relative_humidity")
    # Public methods give the LLM the device's call surface (text/show for a
    # display, etc.) so actuators/displays count as a usable API shape too.
    read_methods = sorted(
        name
        for name in set(re.findall(r"def\s+([a-z][A-Za-z0-9_]*)\s*\(", source))
        if not name.startswith("_") and name not in read_properties
    )

    is_i2c = "i2c" in combined.lower()
    evidence_refs = (
        [{"type": "source", "path": f"{module_name}.py"}]
        if module_name
        else [{"type": "readme", "path": "aht20-readme.md"}, {"type": "source", "path": "aht20-source.py"}]
    )
    context = {
        "import_names": import_names,
        "constructors": constructors,
        "read_methods": read_methods,
        "read_properties": read_properties,
        "bus": ["i2c"] if is_i2c else [],
        "pin_roles": ["i2c_sda", "i2c_scl"] if is_i2c else [],
        "install": {"method": "mpremote mip install", "url": package.get("package_json_url", "")},
        "examples": extract_examples(readme),
        "known_issues": [],
        "evidence_refs": evidence_refs,
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
