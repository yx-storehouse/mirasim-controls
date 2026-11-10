# Mirasim 控制区：以后使用这套固定入口

此文件夹只需保留一份。四个 BAT 与 `bootstrap.ps1` 必须放在一起，不能只复制单个 BAT。

每次双击会先检查私有 GitHub 仓库 <https://github.com/yx-storehouse/mirasim-controls> 的 `main` 分支。有新提交就下载、校验并使用新脚本，已是最新则直接运行。

1. 等当前任务结束，从系统托盘退出 Mirasim。
2. 双击 **01-安装或修复.bat**。
3. 显示完成后重新打开 Mirasim。

**02** 查看状态，**03** 恢复原版，**04** 导出兼容报告。报告固定保存在 `%LOCALAPPDATA%\MirasimControls\diagnostics`，程序原件备份沿用 `%USERPROFILE%\.mirasim-extras\speed-picker`。

本机已安装 Git 并登录有访问权限的 GitHub 账号。在其他电脑使用时，需要 Git for Windows 和相应账号登录，推荐先执行一次 `gh auth login`。运行补丁还需要 Node.js 20+ 或可用的 Mirasim 内置 Node。

断网时，有有效缓存会校验后继续使用，并明确提示无法确认最新；没有缓存则停止。新下载内容校验失败时不切换版本。补丁不会自动结束 Mirasim 任务，文件占用时请完整退出后重试。

日常补丁更新不需要重新下载这个文件夹。若维护者尚未适配新的 Mirasim 结构，自动更新后仍可能提示不兼容，请提供 **04-导出兼容报告.bat** 生成的报告。
