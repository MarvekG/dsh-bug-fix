# @MarvekG/dsh-bug-fix

[![许可证：MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 第一章：安装指南

### 1.1 从 GitHub 安装

需要先安装并确认 `dsh` 可以正常运行。默认从 GitHub 安装：

```sh
dsh plugin --profile web add github:MarvekG/dsh-bug-fix
dsh web
```

这里的 `web` 是 DSH profile 名称。如果使用其他 profile，把 `web` 换成对应的 profile 名称。

安装后，重启 DSH Web 即可生效。

### 1.2 固定版本

如果不想跟随仓库最新代码，可以在仓库地址后加 commit SHA：

```text
github:MarvekG/dsh-bug-fix#<sha>
```

### 1.3 本地调试

克隆本仓库后，在仓库根目录执行：

```sh
dsh plugin --profile web add .
dsh web
```

### 1.4 卸载

从 `web` profile 移除插件：

```sh
dsh plugin --profile web remove @MarvekG/dsh-bug-fix
```

### 1.5 更新

更新时先移除旧版本，再安装新版本：

```sh
dsh plugin --profile web remove @MarvekG/dsh-bug-fix
dsh plugin --profile web add github:MarvekG/dsh-bug-fix
dsh web
```

本地调试时，把第二条命令替换为：

```sh
dsh plugin --profile web add .
```

### 1.6 运行测试

在插件目录执行：

```sh
npm test
```

### 1.7 多入口结构

本包使用 DSH 的子路径入口。当前沙箱修复入口是：

```text
@MarvekG/dsh-bug-fix/sandbox-same-mode
```

它由 `cordis.patch.yml` 单独挂载。以后新增修复时，可以新增一个脚本、一个 `exports` 子路径和一个独立的 patch 行；每个入口拥有自己的 Cordis 生命周期，可以单独加载和卸载。

## 第二章：已解决的问题

本章按问题分别记录修复内容。后续新增问题时，继续在本章增加独立小节。

### 2.1 同等级沙箱权限请求

#### 原始报错

当时执行的命令是 `pwd`，调用参数如下：

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

DSH 在命令真正执行前报错：

```text
sandbox escalation to "workspace-write" is not strictly wider than this call's current "workspace-write" mode
```

#### 为什么会报错

当时的当前权限已经是 `workspace-write`，请求的权限也是 `workspace-write`。这不是申请更高权限，只是重复声明同一个权限，但 DSH 把它当成了无效的“升级请求”。

#### 插件如何处理

插件会在工具**注册时**包装其执行函数，因此同时覆盖普通全局工具和 DSH Web 的 preset-scoped `bash`、`pwsh`、`write`、`edit` 工具。它只会在以下条件同时满足时，把升级字段删除并按当前权限执行：

1. `sandbox_permissions` 是该工具 schema 明确公开的枚举值；
2. `justification` 是非空字符串；
3. 请求权限恰好等于当前调用、当前 session 的有效 sandbox 权限。

这时请求只是重复声明，因而不弹审批，也不再报 `not strictly wider`。

真正的权限升级和所有非法输入仍然保持原来的流程：

- `read-only` → 更高权限：继续申请审批；
- `workspace-write` → `danger-full-access`：继续申请审批；
- 缺少说明、说明为空或参数不完整：继续报错；
- 未被工具 schema 公开的权限值（包括伪造的同级值）：仍由 DSH 原始参数校验拒绝。

#### 插件不会绕过什么

插件不会扩大工作区，也不会修改 `workspaceRoot`，更不会偷偷增加权限。上面的原始调用使用了 `/home/wang/codes/Best-AI-Trader` 作为 `workdir`；如果这个目录不在当前 DSH 工作区内，去掉重复权限报错后，命令仍可能因为沙箱工作区边界而被拒绝。

安装或更新后应重启 DSH Web，使新的 preset-scoped 工具注册时经过本插件；它不会追溯包裹重启前已存在的 session 工具定义。

## 第三章：许可证与友情链接

本项目基于 [MIT 许可证](LICENSE) 开源。

### 友情链接

- [linux.do](https://linux.do/) — 开放、友好的开发者社区。
