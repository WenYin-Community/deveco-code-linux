# 01 - 获取并校验 MasterGo 官方设计源

首次进入时读取 Controller 返回的 todoPayloadPath，将 .todos 原样同步一次 todowrite；恢复已确认阶段时不重复同步。

读取并执行 `references/mastergo/acquire.md`，当前 variant=full，designSource=mastergo。只执行当前阶段。

取数通道按 `requirement-clarification.json` 的 `mastergo.channel` 沿用来源预检结论与用户选择（见 acquire.md §1），阶段内不重复询问；预检判定客户端本地服务可达、本阶段探测或真实读取才发现不可用时，按 mcp-setup 的两条路径重新取得用户选择（见 acquire.md §5）；`magic-manual` 的截图由用户提供，缺图时 capture 会拒绝取数，按报错索图或按缺失输入阻塞（`missing_asset`，见 acquire.md §5）。
