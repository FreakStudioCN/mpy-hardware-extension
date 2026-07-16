
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
      // Pull the artifact index so the Artifacts tab is populated for a resumed session.
      vscode.postMessage({ type: "request_artifacts" });

      // Auto-follow the Activity tab: any new card or streamed content scrolls to the latest.
      // One observer on the container covers every append site (including ones with no explicit
      // scroll, e.g. the artifact browser) and any future one, so call sites don't each re-scroll.
      (function autoFollowActivity() {
        const list = $("activity");
        // The scroll container is .tabwrap (overflow-y:auto), not #activity or its .view parent
        // (both have no overflow), so scroll the closest .tabwrap ancestor.
        const scroller = list && list.closest(".tabwrap");
        if (!scroller || typeof MutationObserver !== "function") return;
        new MutationObserver(() => { scroller.scrollTop = scroller.scrollHeight; })
          .observe(list, { childList: true, subtree: true, characterData: true });
      })();
