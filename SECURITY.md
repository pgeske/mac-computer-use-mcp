# Security

This server controls real Mac apps. Screenshots, accessibility text, and typed input can contain sensitive information. Your MCP harness and model provider receive tool output and may retain it. The bridge does not promise the safeguards or reliability of OpenAI's full application.

## Trust boundaries

- The host's launch configuration is trusted. The model cannot change `--trust-app`, `--read-only`, or the installed executable path through a tool.
- Without exact app trust, each desktop operation requires MCP form approval. Decline, cancellation, missing UI support, and malformed native approval requests fail closed.
- Native permission requests still require the host's response. A trusted app does not bypass macOS or OpenAI permission checks.
- All UI actions are advertised as potentially destructive and open-world. Tool annotations are hints, not enforcement.
- App inspection requires an exact bundle ID and can launch that app. Read-only mode is not a promise of zero desktop side effects.
- App-level trust is broad. A browser, terminal, or settings app can affect data and systems outside its own window. The bridge cannot infer whether clicking a button sends money or deletes a file.
- Screens, documents, and webpages are untrusted input. The model must not treat their instructions as user authorization. Confirm sending, sharing, purchases, deletion, installation, and account/security changes immediately before the consequential step.
- There is no arbitrary-code execution tool or claimed JavaScript sandbox. A harness that already has shell access retains that authority independently.

## Lifecycle

The server closes app-server's input first so it can shut down its threads and native MCP children normally. It snapshots owned descendant process groups before shutdown and escalates against those groups if needed. It does not kill the shared macOS Computer Use service or other harnesses. An unexpected broker exit or forced termination is reported as unverified cleanup, and private state is retained rather than claiming a clean stop. Reparented or newly detached children cannot always be recovered from ancestry after a crash. A forced kill of this bridge or an OS crash can also leave state/processes behind. Inspect owned processes before restarting after a cleanup error. Do not run multiple independent computer-use clients against the same desktop simultaneously.

A timeout or cancellation cannot undo an action already accepted by the OS. Automatic mutation retries are deliberately absent. Reinspect the app before deciding what to do next.

## Dependencies and updates

Only verified OpenAI-signed app-server and native client executables are launched. OpenAI components are installed separately; they are not included in this package. The bridge uses experimental interfaces, so app updates can break compatibility. Pin bridge releases and rerun the harmless smoke test after relevant updates.

## Reporting

Use this repository's GitHub private vulnerability reporting when available, or contact the maintainer privately before publishing a concrete security issue. Do not include tokens, credentials, screenshots, personal app content, or local machine paths in public reports. Include the bridge version, official app-server version, and a minimal reproduction with fake data.
