use super::*;

/// The exact JSON shape `app/ui/main.js` switches on: a `type` tag plus
/// the event's own fields, camelCase-free (these are already
/// single-word field names).
#[test]
fn progress_event_json_shape_matches_what_the_frontend_expects() {
    let started = ProgressEvent::StepStarted {
        op: "install",
        step: 1,
        name: "vscode",
    };
    let json = serde_json::to_value(&started).unwrap();
    assert_eq!(json["type"], "StepStarted");
    assert_eq!(json["op"], "install");
    assert_eq!(json["step"], 1);
    assert_eq!(json["name"], "vscode");

    let finished = ProgressEvent::StepFinished {
        op: "install",
        step: 1,
        name: "vscode",
        skipped: Some(true),
    };
    let json = serde_json::to_value(&finished).unwrap();
    assert_eq!(json["type"], "StepFinished");
    assert_eq!(json["skipped"], true);
}

#[test]
fn op_result_json_shape_is_camel_case_for_log_path() {
    let result = OpResult {
        op: "install",
        ok: false,
        message: "boom".to_string(),
        log_path: Some("/tmp/installer.log".to_string()),
    };
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json["op"], "install");
    assert_eq!(json["ok"], false);
    assert_eq!(json["message"], "boom");
    assert_eq!(json["logPath"], "/tmp/installer.log");
}
