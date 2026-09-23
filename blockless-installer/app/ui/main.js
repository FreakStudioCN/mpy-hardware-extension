// Plain static JS, no build step (see ARCHITECTURE.md's stack decision: no
// Node/npm/JS toolchain anywhere under app/). Talks to the Rust side only
// through window.__TAURI__ (withGlobalTauri: true in tauri.conf.json).
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The GUI knows install's step shape up front (core/src/ops.rs's emission
// map): four named steps, always in this order. repair/repair-runtime/
// update-extension are CLI-only this PR, so no other op needs a list here.
const INSTALL_STEPS = [
  { step: 1, name: "vscode", label: "VS Code" },
  { step: 2, name: "extension", label: "Blockless extension" },
  { step: 3, name: "runtime", label: "Python runtime" },
  { step: 4, name: "settings", label: "Settings" },
];

const screens = {
  ready: document.getElementById("screen-ready"),
  running: document.getElementById("screen-running"),
  success: document.getElementById("screen-success"),
  failure: document.getElementById("screen-failure"),
};

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle("hidden", key !== name);
  }
}

function renderStepList() {
  const list = document.getElementById("step-list");
  list.innerHTML = "";
  for (const step of INSTALL_STEPS) {
    const li = document.createElement("li");
    li.id = `step-${step.step}`;
    li.className = "step pending";
    li.textContent = step.label;
    list.appendChild(li);
  }
  // Deliberately does NOT touch close-notice: a close refused during the
  // gap between clicking Install and this OpStarted arriving is still
  // true right now (the op is genuinely running) -- clearing it here
  // would erase real feedback about a close that just got refused.
  // clearCloseNotice() (via setBusy(false)) is the only place that's
  // actually correct to clear it, once the op is truly over.
}

function setStepState(stepNumber, state, skipped) {
  const el = document.getElementById(`step-${stepNumber}`);
  const stepDef = INSTALL_STEPS.find((s) => s.step === stepNumber);
  if (!el || !stepDef) return;
  el.className = `step ${state}`;
  if (state === "running" && stepDef.name === "vscode") {
    // Settled decision: an indeterminate spinner with this exact text, no
    // byte-level download progress plumbing.
    el.textContent = `${stepDef.label}: Downloading VS Code (542 MB)`;
  } else if (state === "done" && skipped) {
    el.textContent = `${stepDef.label}: already installed, skipped`;
  } else if (state === "done") {
    el.textContent = `${stepDef.label}: done`;
  } else {
    el.textContent = stepDef.label;
  }
}

function hideError(id) {
  const errEl = document.getElementById(id);
  errEl.textContent = "";
  errEl.classList.add("hidden");
}

function showFailure(message, logPath) {
  document.getElementById("failure-message").textContent = message;
  document.getElementById("failure-log-path").textContent = logPath
    ? `Log: ${logPath}`
    : "";
  hideError("save-diagnostics-error");
  showScreen("failure");
}

function setReadyStatus(text, isError) {
  const status = document.getElementById("ready-status");
  status.textContent = text;
  status.classList.toggle("hidden", !text);
  status.classList.toggle("error", Boolean(isError));
}

// close-notice is a sibling of every screen (see index.html), not reset by
// any screen swap -- every one of the three commands that acquire the
// Rust-side OpGuard (run_install, run_uninstall, save_diagnostics) must
// clear it once IT is done, or a notice shown once during that op's run
// stays stuck, now falsely, on whatever renders after it.
function clearCloseNotice() {
  document.getElementById("close-notice").classList.add("hidden");
}

function setBusy(busy) {
  document.getElementById("install-btn").disabled = busy;
  document.getElementById("advanced-link").classList.toggle("hidden", busy);
  if (!busy) {
    clearCloseNotice();
  }
}

listen("progress", (event) => {
  const payload = event.payload;
  // uninstall/verify/diagnostics only ever emit OpStarted/OpFinished (see
  // core/src/progress.rs's emission map) -- this PR's UI has no step list
  // for them, only the ready-screen busy indicator handled below.
  if (payload.op !== "install") {
    return;
  }
  switch (payload.type) {
    case "OpStarted":
      renderStepList();
      showScreen("running");
      break;
    case "StepStarted":
      setStepState(payload.step, "running");
      break;
    case "StepFinished":
      setStepState(payload.step, "done", payload.skipped);
      break;
    default:
      break;
  }
});

listen("op-result", (event) => {
  const result = event.payload;
  setBusy(false);
  if (result.op === "uninstall") {
    // Uninstall always ends back on the ready screen, ok or not. Every
    // non-ok outcome core can report ("VS Code is running", "could not
    // confirm VS Code is closed", a kept journal after a partial removal)
    // tells the user to clear something and re-run -- and the re-run is
    // the Uninstall control on THIS screen. The failure screen is a dead
    // end with no way back to it, which turned "quit VS Code and re-run"
    // into "kill the app and relaunch".
    //
    // result.message carries the same outcome string the CLI prints,
    // including the blk_removal_partial / vscode_kept_but_owned nuances a
    // flat "Uninstalled." would hide from the user of a destructive op.
    setReadyStatus(result.message, !result.ok);
    // A failed uninstall still deserves the diagnostics bundle the failure
    // screen would have offered; it appears here instead, and goes away
    // again once an uninstall succeeds.
    document
      .getElementById("ready-diagnostics-btn")
      .classList.toggle("hidden", result.ok);
    if (result.ok) {
      hideError("ready-diagnostics-error");
    }
    showScreen("ready");
    return;
  }
  if (result.ok) {
    showScreen("success");
  } else {
    showFailure(result.message, result.logPath);
  }
});

listen("close-refused", () => {
  document.getElementById("close-notice").classList.remove("hidden");
});

document.getElementById("install-btn").addEventListener("click", async () => {
  setBusy(true);
  try {
    await invoke("run_install");
  } catch (e) {
    setBusy(false);
    showFailure(String(e), null);
  }
});

document
  .getElementById("advanced-link")
  .addEventListener("click", (event) => {
    event.preventDefault();
    document.getElementById("uninstall-modal").classList.remove("hidden");
  });

document
  .getElementById("uninstall-cancel-btn")
  .addEventListener("click", () => {
    document.getElementById("uninstall-modal").classList.add("hidden");
  });

document
  .getElementById("uninstall-confirm-btn")
  .addEventListener("click", async () => {
    document.getElementById("uninstall-modal").classList.add("hidden");
    setBusy(true);
    setReadyStatus("Uninstalling…");
    try {
      await invoke("run_uninstall");
    } catch (e) {
      setBusy(false);
      showFailure(String(e), null);
    }
  });

// One handler for both diagnostics buttons: the failure screen's, and the
// ready screen's (shown only after a failed uninstall).
async function saveDiagnostics(btnId, errId) {
  const btn = document.getElementById(btnId);
  const original = btn.textContent;
  const errEl = document.getElementById(errId);
  try {
    const path = await invoke("save_diagnostics");
    if (path) {
      hideError(errId);
      btn.textContent = "Saved";
      setTimeout(() => {
        btn.textContent = original;
      }, 2000);
    }
  } catch (e) {
    // A dedicated element, not #failure-message / #ready-status: those
    // already hold the outcome string the user came to read, and a
    // diagnostics-save failure must not overwrite it.
    errEl.textContent = `Could not save diagnostics: ${e}`;
    errEl.classList.remove("hidden");
  } finally {
    // save_diagnostics holds the same Rust-side OpGuard as install/
    // uninstall and can trigger the same close-refused notice while its
    // dialog/zip-write is in flight; this command has no setBusy call of
    // its own (the ready/running/success/failure screens don't apply to
    // it), so it must clear the notice itself on every exit -- success,
    // a cancelled dialog (path is null), or an error.
    clearCloseNotice();
  }
}

document
  .getElementById("save-diagnostics-btn")
  .addEventListener("click", () =>
    saveDiagnostics("save-diagnostics-btn", "save-diagnostics-error"),
  );

document
  .getElementById("ready-diagnostics-btn")
  .addEventListener("click", () =>
    saveDiagnostics("ready-diagnostics-btn", "ready-diagnostics-error"),
  );

// The extension version this installer will install, shown on the ready
// screen. The installer's own version (the one in the setup filename and in
// Add/Remove Programs) is deliberately NOT the extension's: the two ship on
// separate cadences. This surfaces the number a user actually asks about.
//
// Failure is not shown to the user on purpose. A missing sidecar manifest is
// already reported loudly by the first Install click, naming every path it
// searched; a second complaint at startup would be noise, and an empty span
// reads as "no version mentioned" rather than "something is broken". It is
// still logged, so a wrong command name or a malformed manifest is visible.
(async () => {
  try {
    const v = await invoke("extension_version");
    if (v) document.getElementById("ext-version").textContent = ` (${v})`;
  } catch (e) {
    console.warn("extension_version failed:", e);
  }
})();
