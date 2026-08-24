# @MarvekG/dsh-bug-fix

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Chapter 1: Installation Guide

### 1.1 Install from GitHub

Install `dsh` first and make sure it runs correctly. By default, install the plugin from GitHub:

```sh
dsh plugin --profile web add github:MarvekG/dsh-bug-fix
dsh web
```

`web` is the DSH profile name. Replace it with another profile name when needed.

Restart DSH Web after installation for the plugin to take effect.

### 1.2 Pin a version

To use a fixed version instead of following the latest repository state, append a commit SHA:

```text
github:MarvekG/dsh-bug-fix#<sha>
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
dsh plugin --profile web remove @MarvekG/dsh-bug-fix
```

### 1.5 Update

Update by removing the old version and installing the new one:

```sh
dsh plugin --profile web remove @MarvekG/dsh-bug-fix
dsh plugin --profile web add github:MarvekG/dsh-bug-fix
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

This package uses DSH subpath entrypoints. The current sandbox fix is mounted as:

```text
@MarvekG/dsh-bug-fix/sandbox-same-mode
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

## Chapter 3: License and Friend Links

This project is open source under the [MIT License](LICENSE).

### Friend Links

- [linux.do](https://linux.do/) — An open and friendly community for developers.
