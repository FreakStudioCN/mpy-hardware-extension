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
  document.getElementById("close-notice").classList.add("hidden");
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

function showFailure(message, logPath) {
  document.getElementById("failure-message").textContent = message;
  document.getElementById("failure-log-path").textContent = logPath
    ? `Log: ${logPath}`
    : "";
  showScreen("failure");
}

function setReadyStatus(text) {
  const status = document.getElementById("ready-status");
  status.textContent = text;
  status.classList.toggle("hidden", !text);
}

function setBusy(busy) {
  document.getElementById("install-btn").disabled = busy;
  document.getElementById("advanced-link").classList.toggle("hidden", busy);
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
    setReadyStatus(result.ok ? "Uninstalled." : "");
    if (!result.ok) {
      showFailure(result.message, result.logPath);
    } else {
      showScreen("ready");
    }
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

document
  .getElementById("save-diagnostics-btn")
  .addEventListener("click", async () => {
    const btn = document.getElementById("save-diagnostics-btn");
    const original = btn.textContent;
    try {
      const path = await invoke("save_diagnostics");
      if (path) {
        btn.textContent = "Saved";
        setTimeout(() => {
          btn.textContent = original;
        }, 2000);
      }
    } catch (e) {
      document.getElementById("failure-message").textContent = String(e);
    }
  });
