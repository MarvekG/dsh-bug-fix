# @MarvekG/dsh-bug-fix

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

### 2.1 Same-mode sandbox permission requests

#### The original error

The original call ran `pwd` with these arguments:

```json
{
  "command": "pwd",
  "description": "确认当前工作目录",
  "timeoutMs": 10000,
  "workdir": "/home/wang/codes/Best-AI-Trader",
  "run_in_background": false,
  "sandbox_permissions": "workspace-write",
  "justification": "需要确认当前仓库路径以定位辩论会话和提示词文件。"
}
```

DSH rejected it before the command ran:

```text
sandbox escalation to "workspace-write" is not strictly wider than this call's current "workspace-write" mode
```

#### Why it happened

The current permission was already `workspace-write`, and the requested permission was also `workspace-write`. This was not a request for more access; it was only a repeated declaration. DSH treated it as an invalid escalation request.

#### What the plugin changes

The plugin wraps a tool when it is **registered**, which covers both ordinary global tools and the preset-scoped `bash`, `pwsh`, `write`, and `edit` tools used by DSH Web. It removes the escalation fields and runs in the standing mode only when all of these conditions hold:

1. `sandbox_permissions` is a value explicitly advertised by that tool's schema enum;
2. `justification` is a non-empty string; and
3. the requested mode exactly equals the effective sandbox mode for this call and session.

This is only a repeated declaration, so it does not open an approval prompt or return the `not strictly wider` error.

Real permission upgrades and every invalid input keep the original path:

- `read-only` → a wider mode: approval is still required;
- `workspace-write` → `danger-full-access`: approval is still required;
- Missing, blank, or incomplete justification: the original validation error remains;
- A permission value not advertised by the tool schema, including a fabricated same-mode value, remains subject to DSH's original schema validation.

#### What the plugin does not bypass

The plugin does not expand the workspace or change `workspaceRoot`, and it never grants extra access. The original call used `/home/wang/codes/Best-AI-Trader` as its `workdir`; if that directory is outside the current DSH workspace, the command may still be denied by the sandbox boundary after the duplicate-permission error is removed.

Restart DSH Web after installing or updating this plugin so new preset-scoped tool definitions are registered through it. It cannot retroactively wrap tool definitions belonging to sessions that already existed before the plugin started.
