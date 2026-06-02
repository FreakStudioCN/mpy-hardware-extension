"""SSE contract: pin the DeepSeek -> Anthropic stream translation to a golden file
that the extension's parser test ALSO consumes.

Previously the wire format was invented twice and could drift: the server side
hand-faked DeepSeek chunks, the client side hand-faked the Anthropic SSE. This
test makes the server's real `_translate_deepseek_stream` output the single source
of truth (tests/fixtures/anthropic_stream.sse), and test/sse-contract.test.ts on
the extension side reads that same file. Change the translation -> regenerate the
golden (REGEN=1) -> the client test sees the new reality.

Residual gap (intentionally open for now): `_deepseek_chunk_lines` is hand-authored,
not captured from the live DeepSeek API. A future scripts/record-deepseek-fixture.py
(live key) would close that last link.
"""
import json
import os
from pathlib import Path

from app import routes_llm

GOLDEN = Path(__file__).parent / "fixtures" / "anthropic_stream.sse"


def _deepseek_chunk_lines() -> list[bytes]:
    # One realistic DeepSeek stream: streamed assistant text, then a tool call whose
    # id/name arrive first and whose JSON arguments are split across two fragments.
    chunks = [
        {"choices": [{"delta": {"content": "Let me check the board. "}}]},
        {"choices": [{"delta": {"content": "Profiling now."}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "call_1", "function": {"name": "query_board_profile", "arguments": "{\"board_id\":"}},
        ]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": "\"esp32-s3-devkitc-1\"}"}},
        ]}}]},
    ]
    lines = [f"data: {json.dumps(chunk)}".encode("utf-8") for chunk in chunks]
    lines.append(b"data: [DONE]")
    return lines


def _translate() -> str:
    # meter=None: keep the golden focused on the block-translation contract (the
    # credits event has its own coverage in test_credits.py).
    return "".join(routes_llm._translate_deepseek_stream(_deepseek_chunk_lines(), meter=None))


def test_deepseek_to_anthropic_sse_matches_golden():
    produced = _translate()
    if os.getenv("REGEN") == "1":
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(produced, encoding="utf-8")
    assert GOLDEN.exists(), "golden missing; regenerate with REGEN=1"
    assert produced == GOLDEN.read_text(encoding="utf-8")


def test_golden_carries_the_expected_blocks():
    # Guards against a regenerated-but-wrong golden: the contract must still contain
    # streamed text, a tool_use block for the canonical tool, and a clean stop.
    golden = GOLDEN.read_text(encoding="utf-8") if GOLDEN.exists() else _translate()
    assert "text_delta" in golden
    assert "query_board_profile" in golden
    assert "esp32-s3-devkitc-1" in golden
    assert "message_stop" in golden
