# Mirasim 控制区：Git 自动更新入口

固定使用同一套 BAT。每次运行先检查本仓库 `main` 分支，下载并校验最新补丁脚本，再安装或执行所选操作，无须为日常补丁更新重新下载压缩包。

仓库：<https://github.com/yx-storehouse/mirasim-controls>，当前为私有仓库。补丁提供 Codex 速度选择、Claude Fast 开关和 Claude Ultracode 开关。

## 一次准备，以后直接双击

1. 安装 Git for Windows。私有仓库需要具有访问权限的 GitHub 登录；推荐安装 GitHub CLI 并运行一次 `gh auth login`。
2. 保留四个 BAT 与 `bootstrap.ps1` 在同一目录，或者克隆本仓库后直接使用根目录的 BAT。
3. 需要安装补丁时，等待 Mirasim 任务结束，从系统托盘退出 Mirasim，再运行 **01-安装或修复.bat**。完成后重新打开 Mirasim。

本机已经配置 Git、GitHub CLI 和账号登录，可直接使用。其他电脑首次使用时需要自行登录有权访问此仓库的账号。启动器通过现有 GitHub CLI 或 Git 凭据管理器认证，不在脚本中保存 Token。

| 固定入口 | 作用 |
|---|---|
| `01-安装或修复.bat` | 检查脚本更新，然后安装、升级或修复三项控制 |
| `02-查看状态.bat` | 检查脚本更新，然后查看实际补丁状态 |
| `03-恢复原版.bat` | 检查脚本更新，然后使用已校验的原件备份恢复 |
| `04-导出兼容报告.bat` | 检查脚本更新，然后导出当前版本的兼容信息 |

补丁运行需要 Node.js 20+；没有单独安装 Node 时，继续尝试 Mirasim 内置运行环境。启动器不终止正在运行的 Mirasim 或模型任务。安装目录的文件被占用时，会回滚并提示退出 Mirasim 后重试。

## 更新时发生什么

启动器读取远端 `main` 的提交号。已是最新时直接使用本地版本；有新提交时，先把该提交的 `runtime/` 和 `release.json` 放入独立临时目录，校验路径、文件集合和 SHA-256，再切换到新版本。运行窗口会显示补丁版本和 Git 提交号。

日常补丁更新只需维护者推送新脚本，用户继续双击原来的 BAT。固定启动器使用发布协议 1；仅在启动器自身或发布协议发生不兼容变更时，才可能需要重新分发启动器。

断网或远端暂时不可用时，有完整缓存会明确提示“无法确认是最新版本”，重新校验缓存后继续执行；首次运行没有有效缓存时会停止。下载内容校验失败不会切换当前版本，也不会执行错误的新内容。

| 本机位置 | 用途 |
|---|---|
| `%LOCALAPPDATA%\MirasimControls\repository.git` | 拉取本仓库的 Git 对象缓存 |
| `%LOCALAPPDATA%\MirasimControls\releases\<提交号>` | 每个提交的独立运行快照 |
| `%LOCALAPPDATA%\MirasimControls\current.json` | 当前已校验版本、提交号和清单哈希 |
| `%LOCALAPPDATA%\MirasimControls\diagnostics` | 固定的兼容报告目录 |
| `%USERPROFILE%\.mirasim-extras\speed-picker` | 各 Mirasim 版本的程序原件备份 |

恢复和故障诊断也可显式使用已有缓存：

```powershell
.\bootstrap.ps1 -Action restore -Offline
.\bootstrap.ps1 -Action diagnose -Offline
```

不要编辑缓存中的运行快照。维护代码应修改仓库中的 `runtime/`，更新清单并推送。缓存被修改时，校验会拒绝执行。

## 三项控制与兼容性

- **Codex 速度**：跟随配置、标准、Fast、Ultrafast；独立于推理强度。
- **Claude Fast**：明确开启或关闭 Fast；未显式选择前保持原生设置继承。
- **Claude Ultracode**：独立启用原生 Ultracode 编排行为，同时保留所选推理强度；关闭开关不强制抹除其他原生来源的模式设置。

当前补丁引擎为 **4.4.0**，已验证兼容 Mirasim `0.0.750、0.0.761、0.0.771、0.0.774、0.0.785、0.0.787、0.0.792`。其中 787 的原生模型目录变化、可选错误过滤和紧凑布局新参数均被保留；[0.0.792 安装包验证](docs/compatibility-0.0.792.md)确认现有脚本无需修改。脚本自动更新不代表自动猜测任意新版结构；没有已验证适配的新 Mirasim 版本，仍会导出兼容报告并停止写入。

设置影响后续请求；补丁不会改写原生 Claude `settings.json` 或 Codex `config.toml`。上游是否提供实际加速取决于模型、账号及端点。

## 维护者发布更新

推荐直接修改仓库中的 `runtime/`。若已在本地版本目录完成适配，可按明确文件清单导入：

```powershell
node scripts/update-runtime.cjs "C:\path\to\adapted-controls"
```

导入仅接受17个运行文件，保留运行时编码，并让兼容报告输出到固定缓存目录。真实应用原包、版本样本、账户资料与运行备份不属于发布文件。

发布前：

```powershell
node scripts/release-manifest.cjs
node scripts/release-manifest.cjs --check
node --test tests/*.test.cjs
git add runtime release.json scripts tests README.md bootstrap.ps1 .github .gitattributes .gitignore
git commit -m "Adapt controls to the new Mirasim version"
git push origin main
```

`main` 是用户启动器直接读取的发布分支，推送前须完成相应版本的结构核对和验证。CI 使用 Windows、Node.js 24，检查清单及不依赖应用原包的更新、安装、恢复测试。真实版本适配还需在本机保存的样本上验证，不能只靠通用 CI 判定兼容。

## 源码结构

`bootstrap.ps1` 和根目录 BAT 是固定入口；`runtime/` 是随 Git 提交更新的补丁引擎；`release.json` 描述运行文件及其哈希；`scripts/` 提供导入和清单生成；`tests/` 使用模拟程序文件及本地 Git 仓库验证更新和恢复，不依赖账户或在线模型。
