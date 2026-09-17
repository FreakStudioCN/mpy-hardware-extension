//! The progress-event contract every op keeps (see `core/src/progress.rs`).

use super::*;

#[test]
fn install_emits_the_full_progress_sequence_with_the_right_skipped_flags() {
    let dir = temp_dir("install-progress");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let sink = RecordingSink::default();
    let ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &sink);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    install(&env, &ctx).unwrap();

    assert_eq!(
        sink.events(),
        vec![
            ProgressEvent::OpStarted { op: "install" },
            ProgressEvent::StepStarted {
                op: "install",
                step: 1,
                name: "vscode"
            },
            // VS Code is already present in this fixture, so step 1 is a
            // skip for THIS run (`installed_by_us` is false).
            ProgressEvent::StepFinished {
                op: "install",
                step: 1,
                name: "vscode",
                skipped: Some(true)
            },
            ProgressEvent::StepStarted {
                op: "install",
                step: 2,
                name: "extension"
            },
            // Nothing was installed in this fixture's profile yet, so the
            // extension step really ran.
            ProgressEvent::StepFinished {
                op: "install",
                step: 2,
                name: "extension",
                skipped: Some(false)
            },
            ProgressEvent::StepStarted {
                op: "install",
                step: 3,
                name: "runtime"
            },
            // The fixture already answers `mpremote --version` with the
            // pinned version, so the runtime step is a skip.
            ProgressEvent::StepFinished {
                op: "install",
                step: 3,
                name: "runtime",
                skipped: Some(true)
            },
            ProgressEvent::StepStarted {
                op: "install",
                step: 4,
                name: "settings"
            },
            ProgressEvent::StepFinished {
                op: "install",
                step: 4,
                name: "settings",
                skipped: Some(false)
            },
            ProgressEvent::OpFinished { op: "install" },
        ]
    );
}

#[test]
fn repair_emits_steps_1_2_4_only_never_3() {
    let dir = temp_dir("repair-progress");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let sink = RecordingSink::default();
    let ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &sink);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    repair(&env, &ctx).unwrap();

    let steps: Vec<u8> =
        sink.events()
            .into_iter()
            .filter_map(|e| match e {
                ProgressEvent::StepStarted { step, .. }
                | ProgressEvent::StepFinished { step, .. } => Some(step),
                _ => None,
            })
            .collect();
    assert_eq!(
        steps,
        vec![1, 1, 2, 2, 4, 4],
        "repair must never report step 3"
    );
    assert_eq!(
        sink.events().first(),
        Some(&ProgressEvent::OpStarted { op: "repair" })
    );
    assert_eq!(
        sink.events().last(),
        Some(&ProgressEvent::OpFinished { op: "repair" })
    );
}

#[test]
fn repair_runtime_emits_step_3_only() {
    let dir = temp_dir("repair-runtime-progress");
    let manifest = test_manifest();
    let vsix = write_vsix(&dir, b"vsix contents");
    let sink = RecordingSink::default();
    let ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &sink);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);
    // As on a real machine after env/ is removed: nothing answers
    // `mpremote --version` until step 3 has re-provisioned it.
    *env.mpremote_version.borrow_mut() = None;

    repair_runtime(&env, &ctx).unwrap();

    assert_eq!(
        sink.events(),
        vec![
            ProgressEvent::OpStarted {
                op: "repair-runtime"
            },
            ProgressEvent::StepStarted {
                op: "repair-runtime",
                step: 3,
                name: "runtime"
            },
            ProgressEvent::StepFinished {
                op: "repair-runtime",
                step: 3,
                name: "runtime",
                skipped: Some(false)
            },
            ProgressEvent::OpFinished {
                op: "repair-runtime"
            },
        ]
    );
}

#[test]
fn update_extension_emits_step_2_only() {
    let dir = temp_dir("update-extension-progress");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let sink = RecordingSink::default();
    let ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &sink);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    update_extension(&env, &ctx).unwrap();

    assert_eq!(
        sink.events(),
        vec![
            ProgressEvent::OpStarted {
                op: "update-extension"
            },
            ProgressEvent::StepStarted {
                op: "update-extension",
                step: 2,
                name: "extension"
            },
            // `force` bypasses the currency skip, so this can never be a
            // skip -- and the flag says so instead of staying silent.
            ProgressEvent::StepFinished {
                op: "update-extension",
                step: 2,
                name: "extension",
                skipped: Some(false)
            },
            ProgressEvent::OpFinished {
                op: "update-extension"
            },
        ]
    );
}

#[test]
fn verify_uninstall_diagnostics_emit_start_and_finish_only() {
    let dir = temp_dir("support-ops-progress");
    let manifest = test_manifest();
    let vsix = write_vsix(&dir, b"vsix contents");

    let verify_sink = RecordingSink::default();
    let verify_ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &verify_sink);
    let env = FakeEnvironment::new(&verify_ctx.code_candidates[0], &vsix);
    verify(&env, &verify_ctx);
    assert_eq!(
        verify_sink.events(),
        vec![
            ProgressEvent::OpStarted { op: "verify" },
            ProgressEvent::OpFinished { op: "verify" },
        ]
    );

    let uninstall_sink = RecordingSink::default();
    let uninstall_ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &uninstall_sink);
    uninstall(&env, &uninstall_ctx, &UninstallFlags::default());
    assert_eq!(
        uninstall_sink.events(),
        vec![
            ProgressEvent::OpStarted { op: "uninstall" },
            ProgressEvent::OpFinished { op: "uninstall" },
        ]
    );

    let diagnostics_sink = RecordingSink::default();
    let diagnostics_ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &diagnostics_sink);
    let zip_path = dir.join("diagnostics.zip");
    diagnostics(&diagnostics_ctx, &zip_path).unwrap();
    assert_eq!(
        diagnostics_sink.events(),
        vec![
            ProgressEvent::OpStarted { op: "diagnostics" },
            ProgressEvent::OpFinished { op: "diagnostics" },
        ]
    );
}

#[test]
fn a_failing_step_never_emits_its_own_step_finished_or_any_op_finished() {
    let dir = temp_dir("install-progress-failure");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let sink = RecordingSink::default();
    let ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &sink);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);
    // force step 3 (runtime) to fail, same technique as
    // `install_resets_stale_steps_so_an_aborted_run_never_journals_a_step_it_never_reverified`.
    *env.mpremote_version.borrow_mut() = None;
    *env.run_uv_fails.borrow_mut() = true;

    assert!(install(&env, &ctx).is_err());

    let events = sink.events();
    assert_eq!(
        events.last(),
        Some(&ProgressEvent::StepStarted {
            op: "install",
            step: 3,
            name: "runtime"
        }),
        "the last event must be step 3 starting, not finishing: {events:?}"
    );
    assert!(
        !events.contains(&ProgressEvent::StepFinished {
            op: "install",
            step: 3,
            name: "runtime",
            skipped: None
        }),
        "a failing step must never report its own StepFinished: {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ProgressEvent::OpFinished { .. })),
        "OpFinished must never fire on the error path: {events:?}"
    );
}

/// A recording [`ProgressSink`] that reads `state.json` off disk at the
/// exact moment each `StepFinished` fires and records whether that step's
/// own flag was ALREADY persisted -- the event-sequence tests above only
/// prove the events arrive in the right ORDER, which a hoisted
/// `ctx.progress.emit(&ProgressEvent::StepFinished { .. })` moved above its
/// `stamp_and_write` call would still pass. This is what actually catches
/// that mutation: at emit time, a hoisted call would read the journal
/// BEFORE the write, so the flag would still be `false`.
#[derive(Default)]
struct JournalCheckingSink {
    already_persisted: std::sync::Mutex<Vec<(u8, bool)>>,
}

impl JournalCheckingSink {
    fn check(&self, state_path: &Path, step: u8) {
        let flag = State::read(state_path)
            .ok()
            .flatten()
            .map(|s| match step {
                1 => s.steps.vscode,
                2 => s.steps.extension,
                3 => s.steps.python,
                4 => s.steps.settings,
                _ => false,
            })
            .unwrap_or(false);
        self.already_persisted.lock().unwrap().push((step, flag));
    }
}

/// A [`ProgressSink`] wrapping [`JournalCheckingSink`] plus the state path
/// it needs to check against -- kept separate so the checking sink itself
/// stays a plain recorder, matching this module's other fakes.
struct JournalCheckingContext<'a> {
    inner: &'a JournalCheckingSink,
    state_path: PathBuf,
}

impl ProgressSink for JournalCheckingContext<'_> {
    fn emit(&self, event: &ProgressEvent) {
        if let ProgressEvent::StepFinished { step, .. } = event {
            self.inner.check(&self.state_path, *step);
        }
    }
}

#[test]
fn step_finished_never_outruns_its_own_journal_write() {
    let dir = temp_dir("progress-journal-order");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let checker = JournalCheckingSink::default();
    let state_path = dir.join("Blockless").join("state.json");
    let sink = JournalCheckingContext {
        inner: &checker,
        state_path: state_path.clone(),
    };
    let ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &sink);
    assert_eq!(
        ctx.paths.state, state_path,
        "test setup: the sink must check the SAME path ops.rs writes to"
    );
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    install(&env, &ctx).unwrap();

    let checks = checker.already_persisted.lock().unwrap();
    assert_eq!(
        checks.len(),
        4,
        "expected one StepFinished per install step: {checks:?}"
    );
    for (step, already_persisted) in checks.iter() {
        assert!(
            *already_persisted,
            "step {step}'s StepFinished fired before its own stamp_and_write \
             reached disk -- an event that outruns the journal lies to the user"
        );
    }
}

/// Same invariant, `repair` (steps 1, 2, 4 -- never 3): install's own copy
/// of every `stamp_and_write`/`StepFinished` pair is independent source
/// (`ops.rs` has no shared helper between the two ops beyond
/// `stamp_and_write` itself), so a hoist in `repair` specifically would
/// pass the test above without this one.
#[test]
fn repair_step_finished_never_outruns_its_own_journal_write() {
    let dir = temp_dir("progress-journal-order-repair");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let checker = JournalCheckingSink::default();
    let state_path = dir.join("Blockless").join("state.json");
    let sink = JournalCheckingContext {
        inner: &checker,
        state_path: state_path.clone(),
    };
    let ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &sink);
    let env = FakeEnvironment::new(&ctx.code_candidates[0], &vsix);

    repair(&env, &ctx).unwrap();

    let checks = checker.already_persisted.lock().unwrap();
    assert_eq!(
        checks.len(),
        3,
        "expected one StepFinished per repair step (1, 2, 4): {checks:?}"
    );
    for (step, already_persisted) in checks.iter() {
        assert!(
            *already_persisted,
            "repair step {step}'s StepFinished fired before its own \
             stamp_and_write reached disk"
        );
    }
}

/// The re-run a user sees most: everything already there. Steps 2 and 3
/// used to emit `skipped: None` here, so a window could only ever render
/// them as "done" -- the same word it uses for a step that actually
/// installed something.
#[test]
fn a_second_install_reports_every_step_as_skipped() {
    let dir = temp_dir("install-progress-second-run");
    let manifest = test_manifest_matching(b"vsix contents");
    let vsix = write_vsix(&dir, b"vsix contents");
    let env = FakeEnvironment::new(&dir.join("code"), &vsix);

    let first_sink = RecordingSink::default();
    let first_ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &first_sink);
    install(&env, &first_ctx).unwrap();

    let sink = RecordingSink::default();
    let ctx = make_ctx_with_progress(&dir, &manifest, &vsix, &sink);
    install(&env, &ctx).unwrap();

    let skipped: Vec<(u8, Option<bool>)> = sink
        .events()
        .into_iter()
        .filter_map(|e| match e {
            ProgressEvent::StepFinished { step, skipped, .. } => Some((step, skipped)),
            _ => None,
        })
        .collect();
    assert_eq!(
        skipped,
        vec![
            (1, Some(true)),
            (2, Some(true)),
            (3, Some(true)),
            // Step 4 compares the settings file to what it would write and
            // reports `applied: false` when nothing changed.
            (4, Some(true)),
        ],
        "every StepFinished must carry a real skip verdict; None is not one"
    );
}
