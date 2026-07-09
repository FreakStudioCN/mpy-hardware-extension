
      // Skin the static chrome for the initial (English) locale; the session's
      // first request re-skins it to the user's language via setLocale.
      applyStaticI18n();
      // Pull the real device list + credit balance from the extension host on load.
      vscode.postMessage({ type: "request_boards" });
      // Run the environment preflight on load so issues surface before the first deploy.
      vscode.postMessage({ type: "run_doctor_check" });
      // Load the gen-driver input tabs from the host (schema is the source of truth).
      vscode.postMessage({ type: "request_gen_driver_config" });
      // Load the support contacts + diagnostics fields (config is the source of truth).
      vscode.postMessage({ type: "request_support_config" });
      // Load the home partner logos (config-driven; host inlines them as data URIs).
      vscode.postMessage({ type: "request_partners" });
