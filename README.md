# ex-electron

[![CI](https://github.com/DigitalTolk/ex-electron/actions/workflows/ci.yml/badge.svg)](https://github.com/DigitalTolk/ex-electron/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/DigitalTolk/ex-electron/badge.svg?branch=main)](https://coveralls.io/github/DigitalTolk/ex-electron?branch=main)

Desktop shell for the ex team chat. Agents that run on Claude Code or Codex
use [ex-runner](https://github.com/DigitalTolk/ex-runners). Install it from
Homebrew, or — once an admin turns on "Runners in the app" — let this app
install, connect and run it from the Runners tab (direct-download builds only).

## Releases

A tag `vN.N.N` runs `.github/workflows/release.yml`:

- **Direct download** — signed and notarized macOS, Linux and Windows packages on the GitHub Release. Secrets: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` (Developer ID Application), `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- **Mac App Store** — a sandboxed `.pkg` built by `npm run dist:mas` and uploaded to App Store Connect, then submitted for review and released automatically once approved. Running ex-runner from the app is off in this build (`process.mas`), since the sandbox cannot launch it or the harness CLIs. Secrets:
  - `MAS_CSC_LINK` / `MAS_CSC_KEY_PASSWORD` — the *Apple Distribution* certificate as a base64 `.p12`.
  - `MAS_INSTALLER_CSC_LINK` / `MAS_INSTALLER_CSC_KEY_PASSWORD` — the *Mac Installer Distribution* certificate.
  - `MAS_PROVISIONING_PROFILE_BASE64` — a Mac App Store provisioning profile for `com.digitaltolk.ex.electron`.
  - `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY` — the same App Store Connect API key the mobile repository uses.
  - `APPLE_TEAM_ID` — shared with the direct-download job; it is written into the sandbox entitlements (`prebuilt/entitlements.mas.plist` is the template).

The store listing (description, screenshots, privacy policy, review notes) lives in App Store Connect and must exist before the first upload; the lane ships only the binary. The listing's screenshots are rendered from the real chat UI with fixture data (`EX_REPO=../ex node scripts/generate-mas-screenshots.mjs [--force]`, after building `../ex` and this app) into `fastlane/screenshots/en-US/`; drag them into the macOS version page after regenerating.
