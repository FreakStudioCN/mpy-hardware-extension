--- SIPEED MAIXPY EXPORT PHASE PROTOCOL (V0) ---
The task-specific MaixPy API references and examples you need are ALREADY PROVIDED verbatim in the REFERENCES block below (server-resolved for this vision task). Generate the MaixPy code from THAT block — the API signatures, the model wrapper usage, the camera/display setup, and the UART JSONL example are all there.

Do NOT try to read references/*.md or examples/*.py from disk, do NOT file_operation(list) to find a reference directory, and do NOT run build_reference_index.py or validate_reference_index.py to fetch them — those paths are not reachable from this host and the content you need is already in context. If validate_reference_index.py is unavailable, that is expected; do a self-check against the REFERENCES block instead and continue.

If a needed MaixPy API is not covered by the provided references, do not claim MaixPy lacks it: follow SKILL.md and emit a conservative skeleton or link-only guidance, and report the run as partial with the official URL. Deliver sipeed_vision/main.py and sipeed_vision/README.md and end with phase_complete (next_phase=null).
