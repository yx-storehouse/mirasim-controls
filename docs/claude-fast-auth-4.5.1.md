# Claude Fast 开关开启后仍走 Standard：4.5.1 修复

4.5.1 修复原生 Claude 中转 API 的认证传参。部分环境中，Mirasim 虽然正确传入 `fastMode:true`，但同时使用 `ANTHROPIC_AUTH_TOKEN` 并清空 `ANTHROPIC_API_KEY`，Claude Code 的 Fast 资格判断仍返回 `off / preference`。本次真实配置的隔离初始化对照确认：将同一份现有代理凭据改用 `ANTHROPIC_API_KEY` 传入后，Fast 状态变为 `on`。

## 安装

继续使用原来的 **01-安装或修复.bat**，无需重新下载 ZIP。等待任务结束，从系统托盘退出 Mirasim，再运行 BAT；窗口中的补丁版本应为 **4.5.1**。完成后重新打开 Mirasim。

本版本增加安装能力标记，已经安装三项控制的 4.5.0 也会被识别为需要升级。补丁不会结束运行中的任务；已启动的 Claude 进程需要在应用重新打开后重新创建，才会使用新的认证变量。

## 修改范围

修复只作用于 `kind=anthropic` 的原生 BYOK API 路径，并要求使用现有 sealed 代理凭据、认证方式为 `unknown/x-api-key`，且环境里的认证变量仍与该凭据一致。修改发生在生成 `--settings` 之前，因此进程环境和 settings 文件采用同一认证方式。真正的上游 Key 继续保存在原代理内部。

官方 OAuth 登录、协议转换、明文凭据、其他类型的 Provider、缺少凭据、单独覆盖的认证环境，以及显式 `bearer` 认证都保持原行为。没有关闭 Claude Code 的联网资格检查，也没有修改用户的 Claude 设置或订阅权限。

未声明认证方式、实际只接受 Bearer 的非标准 Anthropic 端点应显式配置 `bearer`，以继续使用原认证路径；本次目标中转支持 `x-api-key`。显式 Bearer 路径不属于此次 Fast 认证修复的覆盖范围。

## 验证与结论边界

- 真实运行记录中观察到了入站 `speed` 缺失、上游 `usage.speed=standard`，因此这次不能仅归因于后台标签。
- 同一份真实用户配置的临时副本进行了仅初始化的 A/B 对照：原认证方式为 `off / preference`，API Key 方式为 `on`。没有发送用户消息或调用模型，原配置文件前后哈希一致。
- 本地模拟请求验证了 Fast 开启时发送 `speed:"fast"` 和 `fast-mode-2026-02-01` beta；Fast 关闭时省略这两项。恢复会话、Ultracode、Agent 子代理、SDK 初始化及完整启动选项均已覆盖。
- 自动更新、诊断、安装恢复及认证分支共 63 项测试全部通过，其中认证分支有 24 项隔离行为测试。750、761、771、774、785、787、792、824、827 的保存原版均完成结构识别、完整补丁和语法校验。
- 0.0.824 与 0.0.827 的真实安装包分别通过 4.5.0 → 4.5.1 隔离升级、重复安装及逐字节恢复测试；前端 ASAR 与 4.5.0 的输出一致。
- 经过当前 Mirasim 代理、使用修复后的认证头请求目标中转 `GET /v1/models`，返回 HTTP 200 且包含目标模型；此检查不调用模型。

初始化返回 `on` 表示客户端已经允许 Fast，不等于每次上游都承诺 Fast。服务端支持情况、限流和 Claude Code 的运行期回退仍会影响请求。核对实际速度时，应查看请求体 `speed` 与响应 `usage.speed`；本次 Claude Code 不发送 `service_tier`，只读该字段的界面可能显示 `Standard`。

此次只能把 `preference` 精确归因到认证方式触发的资格判断差异，不能据此断言某个订阅计费开关或组织策略就是原因。
