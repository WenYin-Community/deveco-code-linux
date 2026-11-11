# 设备截图契约（others 两源通用）

本文件只回答一件事：**校准用的"本轮实现截图"怎么取**。不涉及具体设计稿、不写页面名、不写数值。

## 一、主路径：devecocli（PNG）

```text
devecocli ui screenshot --device <name|serial> --path <designToArktsRunDir>/visual-calibration/round-NN/candidate.png
```

- `--device`：设备名或序列号（如 `Pura 90 Pro` / `127.0.0.1:5555`）；只有一台时可省略，但建议显式写。
- `--path`：**具体 `.png` 文件**最稳；父目录必须先存在。给目录时命令会自动命名 `screenshot-<timestamp>.png`，不要用它作为规范候选。
- 命令固定输出 PNG（实测 1.3.4：1256×2760、`89 50 4E 47`，约 1.6 MB）；没有格式开关。
- 输出里可能有升级提示，忽略；**日测/复跑期间不要升级 CLI**。

采集后立即核对并把以下内容写进报告的 `captureLog`：

```text
command / device / format / width x height / bytes / sha256 / capturedAt
```

`candidate` 指向**实际被评分的那一个文件**；不得裁剪、缩放、改名或再编码。

## 二、回退路径（仅当 devecocli 不可用/命令缺失）

1. **hdc 出 PNG**（必须 `-t png` 配 `.png`）：

   ```text
   hdc -t <serial> shell "snapshot_display -f /data/local/tmp/candidate.png -t png"
   hdc -t <serial> file recv /data/local/tmp/candidate.png <designToArktsRunDir>/visual-calibration/round-NN/candidate.png
   ```

2. **设备/版本只能出 JPEG**：`snapshot_display -f /data/local/tmp/candidate.jpeg`（不带 `-t`），拉回后**直接以 `.jpeg` 评分**，不改名。

已实测的后缀规则（不要猜）：

| 命令 | 结果 |
|---|---|
| `-t png` + `.png` | 成功，PNG |
| `-t png` + `.jpeg` | 失败：`suffix must be .png` |
| 不带 `-t` + `.png` | 失败：`suffix must be .jpeg` |
| 不带 `-t` + `.jpeg` | 成功，JPEG |

## 三、采集时机与失败处理

- 部署/启动/进入目标页并稳定后再截；先确认应用在前台。
- 第一次失败可重试一次；仍失败按 `external_tool_failed` / `dependency_unavailable` 完成 blocked，并写清是"无设备""无 devecocli""截图命令失败"中的哪一种。
- 不得复用上一轮的截图，不得用评分脚本的归一化图/热力图当候选。

## 四、禁止事项

- 禁止把 `.jpeg` 改名成 `.jpg` 来迎合路径规则；Controller 接受 `candidate.png|jpg|jpeg`，格式以实际文件为准。
- 禁止为了对齐/评分对候选图做任何几何变换、裁剪或重编码。
- 禁止硬编码设备分辨率/状态栏高度；这些从运行时或 facts 读取。

## 五、与阶段文档的关系

- others-html Full 阶段 5、others-visual Full 阶段 5 在"每轮整屏截图"处引用本文件；其它阶段不重复解释。
- 本文件是**方法契约**，不是产物清单；run 目录仍按各阶段文档的 `visual-calibration/round-NN/candidate.*` 规范路径落盘。
