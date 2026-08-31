"""The descriptorless-port rule, asserted from the shared fixture the scanner also asserts from.

Its own module rather than a section of test_shim.py: this is the one contract in the shim's suite
whose whole point is that a SECOND implementation -- the submodule's list_serial_ports.py, covered
by upy-deploy-plugin/test and upy-flash-mpy-firmware-plugin/test -- agrees with it. Two
implementations bound by nothing drift apart silently, so the fixture is the binding, and a file
named for the contract is where the next reader looks when the two disagree.
"""

import json
import os

import pytest

from serve import parse_scan_output
from shim_test_paths import submodule_root

# submodule_root(), NOT serve.scripts_root(): scripts_root() prefers the vendored <ext>/third_party
# snapshot, which is frozen at the last packaging run. Reading the fixture from there would assert
# the contract as it stood BEFORE the submodule pin moved -- precisely the drift this file exists to
# catch, and invisible because the stale copy still passes. See shim_test_paths.py.
_DESCRIPTORLESS_FIXTURE_PATH = os.path.join(
    submodule_root(), "shared-plugin-scripts", "mpremote", "list_serial_ports_descriptorless_cases.json"
)


def _load_shared_core_cases():
    # A missing fixture must fail loud, never skip: a skip would silently drop the
    # anti-drift contract this test exists for, and would mask a checkout whose submodule
    # pin predates the fixture. Let open() raise FileNotFoundError itself (pre-checking
    # with os.path.exists would mis-report a PermissionError the same way) and name the
    # resolved path so the cause is diagnosable in one read.
    try:
        with open(_DESCRIPTORLESS_FIXTURE_PATH, encoding="utf-8") as fixture_file:
            cases = json.load(fixture_file)["shared_core_cases"]
    except FileNotFoundError as exc:
        raise FileNotFoundError(
            f"shared descriptorless-port fixture not found at {_DESCRIPTORLESS_FIXTURE_PATH} "
            "(submodule not initialised, or pinned before the fixture landed?)"
        ) from exc
    # An empty case list would make pytest.mark.parametrize skip the test outright --
    # the same silent hole a missing file would leave, just reached a different way.
    # Each case's "ports" entries must be the shim's own (port, vid_pid) shape: the
    # fixture also carries a 3-element (port, vid_pid, source) shape for
    # scanner_source_exemption_cases, and a `null` vid_pid there means something this
    # side can't express (see the comment below) -- catch a misplaced one here rather
    # than let it silently pass or misparse downstream.
    if not cases:
        raise ValueError(f"{_DESCRIPTORLESS_FIXTURE_PATH}: shared_core_cases is empty")
    for case in cases:
        for port_entry in case["ports"]:
            if len(port_entry) != 2 or not isinstance(port_entry[1], str):
                raise ValueError(
                    f"{case['name']!r}: shared_core_cases port entries must be "
                    f"[port, vid_pid] with vid_pid a literal string, got {port_entry!r}"
                )
    return cases


# scanner_source_exemption_cases are NOT expressible here: the mpremote text stream has
# no record-source concept (every line it prints is pyserial-derived), so the fixture's
# `null` vid_pid would have to mean "0000:0000" for the pyserial case but "no vid:pid
# token at all" for the two fallback-source cases -- one fixture value, two
# contradictory text spellings depending on `source`. Those cases stay scanner-side,
# covered by the submodule's own deploy/flash smoke suites.
_SHARED_CORE_CASES = _load_shared_core_cases()


@pytest.mark.parametrize("case", _SHARED_CORE_CASES, ids=[case["name"] for case in _SHARED_CORE_CASES])
def test_scan_matches_shared_descriptorless_fixture(case):
    """Real 5-field `mpremote connect list` shape: "{port} {serial} {vid:04x}:{pid:04x}
    {mfr} {product}". A device with no USB descriptor at all reports 0000:0000 for both
    fields; an HC-05 Bluetooth virtual serial port is the motivating case, but that it
    actually enumerates with vid/pid None (-> 0000:0000) is inferred from mpremote/
    pyserial source, not confirmed on real Windows hardware."""
    output = "".join(f"{port} serial0 {vid_pid} Vendor Product\n" for port, vid_pid in case["ports"])

    assert parse_scan_output(output) == case["expected"]


def test_scan_keeps_port_with_no_vid_pid_token_beside_a_real_board():
    # Defensive: `mpremote connect list` always prints a vid:pid token (an unreadable
    # descriptor renders as 0000:0000, never as an absent field), so a token-less line
    # is not a real production shape -- but the filter must still never conflate
    # "no token" with a positively-reported zero descriptor, so this guards against a
    # future tightening that would make it do so.
    ports = parse_scan_output(
        "COM9 serial0 Vendor Product\n"
        "COM48 abc123 303a:1001 Espressif Systems ESP32-S3\n"
    )

    assert ports == ["COM9", "COM48"]
