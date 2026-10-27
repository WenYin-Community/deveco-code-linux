# 01 获取并校验蓝湖上下文

## 阶段入口

读取本次成功 stage-start 返回的 todoPayloadPath，原样把 .todos 调用一次 todowrite。同步成功后才执行以下工作。正常完成后 stage-complete --stage 1 --result passed；失败使用现有稳定 reason code blocked，并保存具体原因。

读取 references/lanhu/mcp-setup.md 和 input-contract.md。完成一次性需求预检后将 requirement-clarification.json 写入当前 run；designSource=lanhu。

确认已配置服务、目标 design_id 和工程。使用 lanhu-capture.mjs overview，然后完整 inspect 全画板分页，保存固定版本、干净图片、节点/样式与坐标映射。不要把项目列表第一项猜作目标；恢复沿用既有 snapshot/version。

按 input-contract 写需求身份、8 个文件 hash、输入安全报告和真实 integrationSnapshot。资源在阶段 2 选择安装；不把当前阶段记为资源已安装。来源/分页/坐标/图片存在不一致时阻塞，不改走 Figma 或 Pixso。

用户明确提供本地图片时，阶段 1 按 input-contract 的“用户提供本地素材”分支运行导入脚本，锁定 manifest，并使用 developer-provided 模式。已有缺资源的阻塞运行保留，新建本次运行。
