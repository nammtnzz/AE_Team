# AE_CodexTeam Native Bridge (phase 1)

Native AEGP plug-in (`AE_CodexTeam_Native.aex`) that replaces the ScriptUI bridge panel and its
`app.scheduleTask` polling loop. In After Effects: **Window → AE_CodexTeam Native Bridge** (violet panel).

| Part | Phase 1 |
|---|---|
| Job inbox, claim, heartbeat, `started`/`status` results, Stop | native C++ (`core/BridgeCore`) |
| Panel UI | native Win32 (`plugin/NativePanel`), no ScriptUI |
| The 44 named AE functions | still the installed ExtendScript function runtime, called via `AEGP_ExecuteScript` in bundle-only mode |

Later phases port the functions to AEGP calls (read-only functions first), at which point no ExtendScript runs.

## Protocol guarantees (same contract as `engine/source/bridge.js`)
- Heartbeat every 2 s with `sessionNonce`, `scripts.revision` (must match the catalog) and `transport: "native-aegp"`.
- Only `aect-job/v2` function plans for this session are accepted; jobs of other sessions are left untouched.
- A job is claimed by no-replace rename to `.running`; `started-<runId>.json` is written before execution
  (no write → no execution); `status-<runId>.json` is written once and never replaced.
- Nothing is ever re-run: not after a failed report, not after Stop, not for `.running` markers left by a restart.
- If another live bridge (ScriptUI panel or another AE) holds the runtime, the native bridge refuses to start
  or pauses instead of fighting over the heartbeat.

## Build and test
Requires Visual Studio 2022 C++ with the Windows 11 SDK, Node.js and the After Effects SDK.

```
native\build.cmd [AE_SDK_Examples_dir]
```
Runs the core protocol tests (`test/CoreTests.cpp`), then the exact scripts sent to AE against the real
function runtime with an ExtendScript shim (`test/script-harness.cjs`), then builds `out/AE_CodexTeam_Native.aex`
(static C++ runtime; depends only on Windows system DLLs).

## Install / remove
After Effects must be closed; AE_CodexTeam (engine) must be installed first.
```
pwsh -File native\Install-NativePlugin.ps1 -Action Install     # one UAC prompt for the shared plug-in folder
pwsh -File native\Install-NativePlugin.ps1 -Action Uninstall   # restores the ScriptUI startup loader
pwsh -File native\Install-NativePlugin.ps1 -Action Status
```
The plug-in goes to `C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\AE_CodexTeam\`. Codex AE files are never touched.
