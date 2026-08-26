# @MarvekG/dsh-plugins

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Chapter 1: Installation Guide

> **⚠️ Upgrading from the old package name `@MarvekG/dsh-bug-fix`: uninstall first, then install.**
> This package has been renamed to `@MarvekG/dsh-plugins`. Because the name changed, the update flow cannot switch over cleanly (the old entry would linger in the profile). Run:
>
> ```sh
> dsh plugin --profile web remove @MarvekG/dsh-bug-fix
> dsh plugin --profile web add github:MarvekG/dsh-plugins
> dsh web
> ```
>
> Do **not** restart DSH Web between the remove and the add, to avoid composition warnings about the missing old name.

### 1.1 Install from GitHub

Install `dsh` first and make sure it runs correctly. By default, install the plugin from GitHub:

```sh
dsh plugin --profile web add github:MarvekG/dsh-plugins
dsh web
```

`web` is the DSH profile name. Replace it with another profile name when needed.

Restart DSH Web after installation for the plugin to take effect.

### 1.2 Pin a version

To use a fixed version instead of following the latest repository state, append a commit SHA:

```text
github:MarvekG/dsh-plugins#<sha>
```

### 1.3 Local debugging

After cloning this repository, run the following from its root:

```sh
dsh plugin --profile web add .
dsh web
```

### 1.4 Uninstall

Remove the plugin from the `web` profile:

```sh
dsh plugin --profile web remove @MarvekG/dsh-plugins
```

### 1.5 Update

Update by removing the old version and installing the new one:

```sh
dsh plugin --profile web remove @MarvekG/dsh-plugins
dsh plugin --profile web add github:MarvekG/dsh-plugins
dsh web
```

For local debugging, replace the second command with:

```sh
dsh plugin --profile web add .
```

### 1.6 Run tests

Run this from the plugin directory:

```sh
npm test
```

### 1.7 Multiple entrypoints

This package uses DSH subpath entrypoints. The current entries are:

```text
@MarvekG/dsh-plugins/sandbox-same-mode
@MarvekG/dsh-plugins/path-viewer
```

It is mounted independently by `cordis.patch.yml`. Future fixes can add one script, one `exports` subpath, and one patch row; each entrypoint then has its own Cordis lifecycle and can be loaded or unloaded independently.

## Chapter 2: Solved Problems

This chapter records each fix separately. Add a new subsection here for every future DSH issue handled by this repository.

### 2.1 Redundant sandbox permission requests

#### The original error

A retry carried these arguments after the session policy had already changed to `danger-full-access`:

```json
{
  "file_path": "/home/wang/codes/StickyProxy/plugin/internal/state/store.go",
  "content": "x",
  "sandbox_permissions": "workspace-write",
  "justification": "write the requested plugin fix outside the workspace"
}
```

DSH rejected it before the write ran:

```text
sandbox escalation to "workspace-write" is not strictly wider than this call's current "danger-full-access" mode
```

#### Why it happened

Tool schemas advertise every possible escalation target because the effective policy is session-specific. A model can retain a retry instruction created under a narrower policy after the session has switched to the same or a wider mode. In the example, `workspace-write` is lower than the current `danger-full-access` policy, so the requested field does not add any capability and DSH correctly rejects it as a non-escalation.

#### What the plugin changes

The plugin wraps a tool when it is **registered**, which covers both ordinary global tools and the preset-scoped `bash`, `pwsh`, `write`, and `edit` tools used by DSH Web. It removes the escalation fields and runs in the standing mode only when all of these conditions hold:

1. `sandbox_permissions` is a value explicitly advertised by that tool's schema enum;
2. `justification` is a non-empty string; and
3. the requested mode is no wider than the effective sandbox mode for this call and session.

This is a redundant declaration, so it does not open an approval prompt or return the `not strictly wider` error.

Real permission upgrades and every invalid input keep the original path:

- `read-only` → a wider mode: approval is still required;
- `workspace-write` → `danger-full-access`: approval is still required;
- Missing, blank, or incomplete justification: the original validation error remains;
- A permission value not advertised by the tool schema, including a fabricated same-mode value, remains subject to DSH's original schema validation.

#### What the plugin does not bypass

The plugin does not expand the workspace or change `workspaceRoot`, and it never grants extra access. A request run while the effective mode remains `workspace-write` can still be denied outside its workspace after the redundant escalation fields are removed.

Restart DSH Web after installing or updating this plugin so new preset-scoped tool definitions are registered through it. It cannot retroactively wrap tool definitions belonging to sessions that already existed before the plugin started.

### 2.2 Path clicks open a web viewer instead of a native app

#### The original error

Clicking a file path in DSH Web produced:

```text
path open failed: path open failed: spawn powershell.exe ENOENT
```

#### Why it happened

Under WSL, DSH hands clicked paths to the Windows desktop through `powershell.exe`. With `[interop] appendWindowsPath = false` in `/etc/wsl.conf` the Windows directories are not on `PATH`, so the bare-name spawn fails with `ENOENT`. Spawning Windows processes from WSL is fragile anyway, and the GUI itself already runs in the Windows browser.

#### What the plugin changes

The new `dsh-plugins-path-viewer` entry replaces the native open flow with an in-browser one:

1. It registers a loopback-fenced `GET /view?path=<abs>[&line=N]` route on the same web server: files render as line-numbered tables (HTML-escaped, truncation banner past 4 MiB, binary detection), and directories render as browsable listings.
2. It injects a small head script into the GUI page that intercepts the RPCs for `host.openPath` / `host.openTextFile`, opens `/view?path=…` in a new browser tab instead, and fabricates the success envelope (`{type:'server-response',rpcId,result:{ok:true,value:{opened:true}}}`) so the UI treats the click as handled. If the popup is blocked, the original request passes through untouched. Common source files receive `highlight.js` syntax highlighting; unknown extensions safely fall back to plain text.

No Windows process is ever spawned; everything stays on the origin the browser already trusts. Config keys: `maxBytes` (render cap) and `intercept` (RPC methods to reroute). Restart DSH Web after installing or updating.

## Chapter 3: License and Friend Links

This project is open source under the [MIT License](LICENSE).

### Friend Links

- [linux.do](https://linux.do/) — An open and friendly community for developers.
