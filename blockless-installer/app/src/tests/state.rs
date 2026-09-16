use super::*;

#[test]
fn install_attempts_are_allowed_up_to_the_limit_then_refused() {
    for attempt in 1..=MAX_INSTALL_ATTEMPTS_PER_PROCESS {
        assert!(install_attempt_allowed(attempt), "attempt {attempt}");
    }
    assert!(!install_attempt_allowed(
        MAX_INSTALL_ATTEMPTS_PER_PROCESS + 1
    ));
}

#[test]
fn op_guard_refuses_a_second_acquire_while_held_and_releases_on_drop() {
    let flag = AtomicBool::new(false);
    let first = OpGuard::try_acquire(&flag).expect("first acquire must succeed");
    assert!(
        OpGuard::try_acquire(&flag).is_none(),
        "must refuse a second concurrent acquire"
    );
    drop(first);
    assert!(
        OpGuard::try_acquire(&flag).is_some(),
        "must be acquirable again once the first guard is dropped"
    );
}
