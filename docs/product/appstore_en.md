I. Project Background & Core Positioning

1.1 Our Positioning
We are the world's first full-stack MicroPython ecosystem service provider focused on MCU scenarios. Our core products consist of two main lines:
- uPyPI: A one-stop MicroPython driver package repository, with 150+ standardized driver implementations for electronic modules already completed. Analogous to PyPI / npm in the embedded domain.
- uPyOS: A lightweight, Android-like embedded operating system, built on MicroPython + LVGL, running on the ESP32 series of MCUs. Supports graphical UI and app-store-style install/update. Based on MicroPythonOS.

Core goal: Build the "Android ecosystem" of the smart hardware domain — lower the barrier to hardware development so that even users with zero background can quickly complete hardware development.

1.2 Benchmark Project & Core Baseline
The V1 feature set is benchmarked against the open-source project BadgeHub (https://badge.why2025.org — https://github.com/BadgeHubCrew/badgehub-app), which provides an app store service for hacker-camp event badge devices. We reference its core logic, adapt and optimize it for our product characteristics, and aim to ship quickly. The API design refers to its technical architecture. Tech stack: Node.js + PostgreSQL + React.

1.3 Core Terminology (Tightly Coupled with Development)
- MicroPython: A slim embedded variant of Python that runs on resource-constrained MCUs with 256KB–8MB of memory. The runtime foundation of uPyOS.
- MCU: Chips such as ESP32 / ESP32-S3 that have no full OS. uPyOS runs directly on this class of hardware.
- uPyOS: Our in-house embedded OS, currently at version 0.9.0. Capabilities include a desktop launcher, app install/uninstall, system settings, WiFi management, etc.
- D-Shell: The hardware terminal devices that ship with uPyOS — analogous to an Android phone. The primary host for uPyOS.
- LVGL: A general-purpose embedded GUI engine. The underlying renderer for the uPyOS interface.
- .mpk: The application package format for uPyOS. Essentially a compressed archive — analogous to Android's APK. The internal directory structure is fixed and must not be modified.
- MANIFEST.JSON: A fixed metadata file inside the mpk package, declaring the application name, version, entry point, publisher, etc. Analogous to the Android manifest.
- fullname: The globally unique identifier of an application, in reverse-domain-name format. Must be globally unique.
- slug: The fullname with dots replaced by hyphens. Used in API routes and page URLs.
- revision: An internal auto-incrementing version number for the application, running in parallel with the business version number. All historical versions must be retained forever — devices must be able to download older versions.
- Active Module: A hardware module that broadcasts over Bluetooth on its own — can actively report its chip model and capabilities, and is auto-detected by the system.
- Raw Module: An ordinary off-the-shelf bare sensor module without broadcast capability. Adaptation relies on scanning, manual selection, or natural-language recognition. The system is designed around this baseline.
- device_fingerprint: An anonymous, unique fingerprint for a device. Generated on-device by SHA-256 hashing the hardware unique ID, yielding a 64-character hex string. Irreversible. Used as the underlying data for deduplication, device profiling, and the recommendation algorithm.
- hardware_tags: A JSON structure declaring the application's hardware dependencies, distinguishing required vs. optional hardware capabilities. Used for hardware-based matching/recommendation in V2.
- capability: An abstracted hardware function, not tied to a specific chip model. The same capability can be satisfied by multiple sensors.
- app_index.json: The single static entry file used by the device-side store. Its format, fields, and structure are permanently locked — any change would brick already-shipped devices.
- Claude AI Skill: The underlying AI code-generation capability. Input: hardware profile + natural-language requirement. Output: a complete, runnable MicroPython project and an mpk install package.

III. V1 Feature Requirements (Fast-Shipping Version)

3.1 V1 Core Feature Checklist (Must Ship)
(Cannot be displayed outside Feishu docs for now.)

3.2 V1 — Build the Table & Ingest Data, but Don't Surface in the UI (V2 Instrumentation — Must Be Designed In Sync)
The following fields / tables are write-and-store-only in V1, not exposed in the frontend. They reserve capability for V2:
- installs_count: Cumulative install count. Used as a weight in V2 leaderboards / recommendations.
- hardware_tags: An optional field on the developer's app submission. Core input for hardware matching in V2.
- device_profiles: The full device-profile table. V1 must complete the schema and start receiving data.
- stars_count: Application favorite count. V1 builds the table and stores the data; V2 exposes the button on the frontend.

Hard requirement: The install-reporting endpoint MUST include device_fingerprint in every request. If the field is missing or generated incorrectly, the V2 recommendation system cannot be built on top and would need a full rebuild.

3.3 V1 API Reference Spec (Adjustable as needed — reference only)
Public endpoints (no auth required):
```Bash
GET  /app_index.json
GET  /api/v1/apps
GET  /api/v1/apps/{slug}
GET  /api/v1/apps/{slug}/versions
GET  /api/v1/apps/{slug}/rev/{n}/files/{path}
POST /api/v1/apps/{slug}/rev/{n}/report/install
POST /api/v1/devices/profile
GET  /api/v1/os/latest
GET  /api/v1/os/releases
```
Developer endpoints (require authentication):
```Bash
POST   /api/v1/developer/apps
PATCH  /api/v1/developer/apps/{slug}/draft
POST   /api/v1/developer/apps/{slug}/draft/icon
POST   /api/v1/developer/apps/{slug}/draft/files/{path}
POST   /api/v1/developer/apps/{slug}/publish
POST   /api/v1/developer/apps/{slug}/new-version
DELETE /api/v1/developer/apps/{slug}
GET    /api/v1/developer/apps/{slug}/stats
```

3.4 V1 Core Data Table Design Requirements (Adjustable as needed — reference only)
Design tables along the following entities, leave extension fields, and avoid major schema rewrites later:
- apps — main applications table
  - Must include: slug, application name, publisher, category, install count, download count, favorite count, hardware_tags, minimum OS version, screenshots, status, publish time.
- app_versions — application versions table
  - Must include: application ID, revision number, business version number, mpk URL, file hash, file size, standardized icon URL.
- install_reports — install report table
  - Must include: application ID, revision, device_fingerprint, device OS version, report time. Deduplicate uniquely by (application, device_fingerprint) — the same device only counts as one valid install.
- device_profiles — device profile table
  - Must include: device fingerprint, OS version, hardware platform, screen resolution, free flash, detected-hardware set (JSON structure), installed-applications list, last-online time.
- download_logs — download logs table
  - Must include: application ID, revision, hashed client ID, download time.
- users — developer accounts table
  - Must include: third-party account ID, username, email.
- stars — favorites relation table
  - Must include: user ID, application ID. (V1 builds the table; V2 exposes the feature.)
- modules — hardware module registry table
  - Must include: chip name, display name, hardware-capability set, interface type, associated uPyPI package name, Bluetooth broadcast info, keywords.

IV. V2 Advanced Feature Requirements (R&D Must Pre-Architect for These)

4.1 Leaderboards & Discovery
1. Provide multi-dimensional leaderboards: most-installed, most-downloaded, most-favorited, newest releases, fastest-rising.
2. Each leaderboard has its own independent refresh cadence: hourly / real-time / daily.
3. "Fastest-rising" must be weighted by 7-day installs and time-since-release.

4.2 User Favorites
1. Authenticated users can favorite / un-favorite applications.
2. The user-center page shows a "My Favorites" list, with category and search support.
3. The application detail page shows total favorite count.
4. UX: Optimistic UI updates on the frontend, asynchronous writes on the backend.

4.3 Hardware-Aware Smart Recommendations
1. A three-tier graceful-degradation matching strategy is mandatory: full hardware profile → partial device profile → no device info → fallback to a popular leaderboard.
2. Match based on hardware_tags vs. the device's detected hardware, and filter out incompatible applications.
3. When a device newly detects a piece of hardware, proactively push a recommendation tip for matching applications.
4. Reserve endpoints: GET /api/v2/recommend?device={fingerprint}&limit=10 and GET /api/v2/recommend?hardware={chip_list}&limit=10
5. Maintain a unified hardware-capability enumeration standard; any newly added capability must be registered in the enum.

4.4 Collaborative-Filtering Recommendations
1. Based on device install behavior, implement "Users who installed this also installed…" related recommendations.
2. Compute the affinity matrix daily as an offline batch job. Cache results — do NOT compute on the fly.
3. Reserve endpoint: GET /api/v2/apps/{slug}/related

4.5 Semantic Search
1. Support natural-language fuzzy search, matching not just the title keywords but also the application description and hardware-capability tags.
2. Hybrid keyword + vector semantic retrieval, supporting both Chinese and English content matching.
3. On application publish, automatically generate the text embedding and store it. Reserve vector-storage and retrieval capability.
4. Reserve endpoint: GET /api/v2/apps/search?q=xxx&semantic=true

4.6 AI Code Generation (Core Differentiator)
1. Four user-selectable hardware-input methods: bind a device and import its profile, on-device I²C scan-and-report, manual module selection, natural-language hardware description.
2. Flow: intent decomposition → hardware-capability matching → missing-hardware notification → link to uPyPI drivers → AI code generation → mpk packaging.
3. Delivery formats: download the install package, one-click push to a device, online edit and repackage, save as draft and publish to the store.
4. Missing hardware does NOT interrupt the flow — instead, present a procurement recommendation list.
5. Asynchronous task mechanism: submitting a generation request returns a task ID; clients poll for the result.
6. Per-user-identity rate-limit configuration for daily calls.
7. Reserve endpoints: POST /api/v2/generate and GET /api/v2/generate/{task_id}

4.7 Natural-Language Hardware Recognition
1. The user describes hardware in free text; the AI automatically parses, matches candidate chip models, and returns confidence scores.
2. After user confirmation, write the result into the device profile and apply it to the recommendation logic.
3. Reserve endpoint: POST /api/v2/hardware/parse-text

4.8 Developer Analytics Center
1. Data dimensions: download/install trend line charts, distribution by device OS version, distribution by hardware model, aggregated top-10 application crash errors.
2. Support automatic packaging and publishing triggered by GitHub repository tag pushes.

V. Mandatory Device-Side Reporting Spec (Frontend & Backend Must Align)

5.1 Reporting Events & API Conventions
(Cannot be displayed outside Feishu docs for now.)

5.2 Device Fingerprint Generation Rules (Locked — Do Not Change)
The device SHA-256-hashes its hardware unique ID, producing a 64-character hex string. Irreversible — the original MAC cannot be recovered. Every report MUST include this field.

5.3 General Reporting Principles
All reporting requests, on failure, must fall back to silent retry or local discard ONLY. They must never trigger a popup, block the user, or interfere with the main device flow.

VI. Cross-Version Compatibility — Hard Constraints (Reference Only)
1. All V1 API routes, request parameters, and response structures are permanently frozen — no breaking changes ever.
2. All V2 features ship under brand-new /api/v2/ routes — do not modify legacy endpoints.
3. The static file app_index.json has its field structure, hierarchy, and key names permanently locked. No version may change them.
4. The V1 schema is designed completely in one pass. V2 may only ADD fields — never delete or modify existing business fields.

VII. Global Development Guidelines
- All revisions are archived permanently. Historical install packages and version records must never be deleted.
- The internal directory structure of mpk packages and the MANIFEST.JSON rules are fixed. The server must validate format conformance.
- Developer uploads — both assets and install packages — must go through validity checks and security scans.
- All statistical and recommendation data should prefer offline pre-computation + caching, to avoid DB pressure under high concurrency.
- Authentication, developer permissions, and API authorization must be designed under a single unified system, with room reserved for future permission extensions.
- The architecture must pre-reserve capabilities for vector retrieval, asynchronous tasks, scheduled tasks, and a caching layer, in order to accommodate V2 feature iterations.
