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

### 2.1 冗余沙箱权限请求

#### 原始报错

session 权限已经切换为 `danger-full-access` 后，重试仍携带以下参数：

```json
{
  "file_path": "/home/wang/codes/StickyProxy/plugin/internal/state/store.go",
  "content": "x",
  "sandbox_permissions": "workspace-write",
  "justification": "write the requested plugin fix outside the workspace"
}
```

DSH 在写入真正执行前报错：

```text
sandbox escalation to "workspace-write" is not strictly wider than this call's current "danger-full-access" mode
```

#### 为什么会报错

因为有效权限按 session 决定，工具 schema 会公开所有可能的升级目标。模型可能在较窄权限下收到重试指引，然后在 session 切换到相同或更宽权限后继续使用该参数。这个例子中，`workspace-write` 比当前的 `danger-full-access` 更窄，请求字段并没有增加能力，因此 DSH 正确地将它拒绝为非升级请求。

#### 插件如何处理

插件会在工具**注册时**包装其执行函数，因此同时覆盖普通全局工具和 DSH Web 的 preset-scoped `bash`、`pwsh`、`write`、`edit` 工具。它只会在以下条件同时满足时，把升级字段删除并按当前权限执行：

1. `sandbox_permissions` 是该工具 schema 明确公开的枚举值；
2. `justification` 是非空字符串；
3. 请求权限不宽于当前调用、当前 session 的有效 sandbox 权限。

此时请求只是冗余声明，因而不弹审批，也不再报 `not strictly wider`。

真正的权限升级和所有非法输入仍然保持原来的流程：

- `read-only` → 更高权限：继续申请审批；
- `workspace-write` → `danger-full-access`：继续申请审批；
- 缺少说明、说明为空或参数不完整：继续报错；
- 未被工具 schema 公开的权限值（包括伪造的同级值）：仍由 DSH 原始参数校验拒绝。

#### 插件不会绕过什么

插件不会扩大工作区，也不会修改 `workspaceRoot`，更不会偷偷增加权限。有效权限仍为 `workspace-write` 时，去掉冗余升级字段后，工作区外的请求仍可能因为沙箱工作区边界而被拒绝。

安装或更新后应重启 DSH Web，使新的 preset-scoped 工具注册时经过本插件；它不会追溯包裹重启前已存在的 session 工具定义。

## 第三章：许可证与友情链接

本项目基于 [MIT 许可证](LICENSE) 开源。

### 友情链接

- [linux.do](https://linux.do/) — 开放、友好的开发者社区。
