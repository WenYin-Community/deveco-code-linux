# 视觉规格（visual-spec.json）

阶段 1 必产出 `<runDir>/stage1/visual-spec.json`，把设计稿的**可量化视觉事实**（配色、背景、字阶、圆角、图标来源、分区占比）固化为下游方案设计阶段（others-visual 阶段 2）的强输入。没有它，模型只能按"常见 App 习惯"猜主题——实测中出现过把深绿雾山主题做成白底浅色卡片、Round 1 仅 39.9 分并整页重写返工的事故。

适用来源：`others-visual`（截图）。Pixso / Figma / MasterGo / others-html 由各自 DSL / JSX / 布局事实证据承载（others-html 的阶段 1 语义规格见 `html-facts.md`），不要求本文件。

## 一、绝对原则

1. **只记录有证据的值**。每个值必须带 `evidence`：写识别结果里的观察条目（`global_observations[i]` 或某组件的 `visual_evidence`）或 `visual-probe.json` 的测量字段。
2. **无法判定的写 `"unknown"`**，并同时在 `uncertainties` 里写清原因。禁止编造精确色值、字号、圆角——"看起来像深绿"不是 `#1F3B2E` 的依据。
3. **本文件是下游的权威视觉输入**。`design-doc.md`、页面实现与视觉校准必须以它为准；与它冲突时必须先回到阶段 1 修订本文件（并写明新增证据），不得各自发挥。
4. 本文件由阶段 1 写入；`others-visual` 方案设计阶段（阶段 2）确认后，本文件进入确认快照，任何改动都会被 Controller 拒绝。**确认后**本 run 内不得改写；若确认环节要求修改视觉取值，只能在阶段 2 内把差异记录到 `component-analysis.md` 的 `uncertainties` 并在设计文档中标注待定，不得改写本文件，也不得为了消除差异重新生成阶段 1 产物。

## 二、结构

```json
{
  "schemaVersion": 1,
  "designSource": "others-visual",
  "producer": {
    "kind": "recognize_ui_components | main-model-vision",
    "evidence": [
      "stage1/component-vision-analysis.json: analysis.global_observations[0]",
      "stage1/visual-probe.json: background.stops"
    ]
  },
  "canvas": { "logicalWidth": 360, "logicalHeight": 792, "scale": 2 },
  "background": {
    "kind": "solid | gradient | image | unknown",
    "value": "linear-gradient(180deg, #16281F 0%, #27402F 55%, #1B2E24 100%)",
    "evidence": "stage1/component-vision-analysis.json: analysis.global_observations[1]"
  },
  "palette": [
    { "color": "#16281F", "role": "background-base", "evidence": "…" },
    { "color": "#E8C87A", "role": "primary-accent", "evidence": "…" },
    { "color": "#FFFFFF", "role": "text-on-dark", "evidence": "…" }
  ],
  "typography": [
    { "role": "page-title", "sizePx": 28, "weight": 700, "color": "#FFFFFF", "lineHeightPx": "unknown", "evidence": "…" },
    { "role": "section-title", "sizePx": 16, "weight": 600, "color": "#FFFFFF", "evidence": "…" },
    { "role": "nav-label", "sizePx": 9, "weight": "unknown", "color": "#F2F4F3", "evidence": "…" }
  ],
  "textInventory": [
    { "text": "运动", "role": "page-title", "evidence": "stage1/component-vision-analysis.json: analysis.visible_components[0].visual_evidence" },
    { "text": "训练课程", "role": "section-label", "evidence": "stage1/visual-probe.json: textRows[4]", "inferred": true, "reason": "识别清单未覆盖该区块标题，按位置与字号推断" }
  ],
  "radii": [
    { "target": "card", "radiusPx": 12, "evidence": "…" },
    { "target": "chip", "radiusPx": 999, "evidence": "…" }
  ],
  "iconSource": { "kind": "raster | vector | glyph | unknown", "evidence": "…" },
  "bands": [
    { "name": "status-area", "heightRatio": 0.05, "evidence": "…" },
    { "name": "hero", "heightRatio": 0.57, "evidence": "…" },
    { "name": "bottom-nav", "heightRatio": 0.13, "evidence": "…" }
  ],
  "uncertainties": ["字重无法从截图判定，按标题层级取 700/600", "圆角仅主推卡片可辨，其余记 unknown"]
}
```

字段约束：

- `background.kind != "unknown"` 时 `value` 必须非空；`gradient` 必须写出**方向与全部停点**（至少 2 个）。
- `palette` 至少 1 项，每项 `color` 为 `#RRGGBB` 或 `"unknown"`，`role` 与 `evidence` 非空。
- `typography` 至少 1 项，覆盖设计稿中实际存在的角色（页面标题、区块标题、正文、辅助文字、导航标签）；`sizePx` 为正数或 `"unknown"`。
- `textInventory` **必填**（截图路径）：截图里出现的每条可见文案逐条入表，每条 `{ "text", "evidence" }`；未标 `inferred` 的条目，其 `text`（≥2 字）必须能在 `stage1/component-vision-analysis.json` 的组件名 / `visual_evidence` / `global_observations` 里找到——找不到就是**编造文案**，Controller 拒绝。识别清单没覆盖到的文案标 `inferred: true` 并写 `reason`，同时在 `uncertainties` 记一条。**无文字页面允许空数组**，但必须在 `uncertainties` 说明"本页无可见文字"及漏检风险（probe 无 OCR，无法保证每条可见文案完整）。
- **页面可见文案只能来自本清单**：`generated-ui-manifest.userVisibleStrings` 必须逐条落在 `textInventory` 里，来自 `inferred` 条目的字符串还要同时列进 `inferredStrings`。
- `bands` 按视觉从上到下列出分区与高度占比（`heightRatio` 之和 ≈ 1.0，允许 ±0.05）。截图来源直接沿用 `visual-probe.json` 的 `bands`（已是穷尽分区，和恒为 1）；**不得补一个"未识别区/remainder"分区**，也不得把缺额摊给间距。识别不出分区时可空数组，但 `uncertainties` 必须说明。
- `uncertainties` 可为空数组；一旦有任何字段取 `"unknown"`，必须逐条说明。**`uncertainties` 只用于记录"无法判定"，不得用来豁免硬约束**：把一条违反 §二 的取值写进 `uncertainties` 不等于该取值合规。

## 三、各来源的提取方式

### 取证模式（仅截图路径）

宿主模型的视觉能力不同，取证方式也不同。**`visual_probe` 在三种模式下都必跑**，读数永远以它为准；变的只是"组件清单由谁给"。

| 模式 | 何时使用 | 组件清单来源 | `inputs-manifest.json.visualEvidenceMode` |
|---|---|---|---|
| **M0 无视觉**（默认） | 宿主模型不能读图 | `recognize_ui_components`，调用一次 | `recognize-ui-components` |
| **M1 主模型可读图** | 宿主模型支持图片输入、且没有可用的视觉 MCP | 主模型**一次性**读图，落成同构产物 | `main-model-vision` |
| **M2 两者都有** | 模型可读图且 MCP 已配 | 工具产清单，主模型只做交叉校验与补漏 | `recognize-ui-components` |

**三档通用不变量**：

1. **数值只来自 probe**。模型（不论工具还是主模型）给出的字号、圆角、色值一律只作交叉校验，**不得覆盖测量值**。`stage1/visual-spec.json` 与 `stage1/visual-probe.json` 会被 Controller 逐项对账（画布、背景停点、`bands`、字号），对不上即拒绝。
2. **M1 的读图预算**：整个阶段 1 **至多 3 次**（全图 1 次 + 至多 2 次区域放大），写入 `inputs-manifest.json.visionReads`，Controller 校验为 1–3。读图比像素采样更贵、也更容易陷入"再放大确认一下"，所以预算更紧。
3. **M1 必须落成与工具产物同构的结构化产物**：`producer.tool="main-model-vision"`、`status="ok"`、`analysis.visible_components[]` 每项带 `id`/`name`/`visual_evidence`/`component_candidates`。读不出的内容写 `unknown`，**不得 degraded** —— M1 降级即 blocked。
4. 无论哪种模式，**probe 都要跑**，都不许用"我看得见"替代测量。

### others-visual（截图）

截图路径没有 DSL / JSX / CSS 可读，视觉事实由**两个独立生产者**共同给出，缺一不可：

| 生产者 | 回答什么 | 是否经过模型 | 权威性 |
|---|---|---|---|
| `scripts/visual_probe.mjs` | **确定性近似值**：画布与缩放、背景色与渐变停点、分区与占比、文字行墨迹高度（非字体字号）、色板、启发式圆角估计 | 否 —— 纯像素算术，确定可复现 | 数值**以它为准** |
| `recognize_ui_components` | **语义**：有哪些组件、命名、组件候选、文本内容、视觉描述 | 是 —— 多模态估算，实测对字号/圆角低估 25–60% | 只作语义与交叉校验 |

两者冲突时以 probe 为准，并把差异记入 `uncertainties`。

1. **先跑一次 probe**（整个 run 只跑这一次）：

   ```text
   node scripts/visual_probe.mjs \
     --screenshot <designToArktsRunDir>/source/visual/screenshot.png \
     --out <designToArktsRunDir>/stage1/visual-probe.json
   ```

   可选用 `--logical-width <n>` 声明目标逻辑画布宽度（默认 360）。
   **硬性约束（Controller 会校验）**：
   - 只能调用一次。不得换参数重跑、不得对裁剪区域二次取样、不得"再确认一下某一块"。
   - 一次结果不足以判定的字段写 `"unknown"` 进 `uncertainties`，**不得用多次取样逼近**。
   - `budget.passes` 必须为 `1`，`budget.withinBudget` 必须为 `true`。

2. **从 probe 取值，不从识别结果取值**：

   | spec 字段 | probe 来源 |
   |---|---|
   | `canvas` | `canvas.physicalWidth/Height`、`canvas.logicalWidth/Height`、`canvas.scale`（由 `scaleRule` 算得，**不得按 750→375 之类规则推定**） |
   | `background` | `background.kind/direction/stops` → `linear-gradient(<angle>deg, #RRGGBB <pos>%, …)`；`kind=solid` 时取 `stops[0].color` |
   | `bands` | `bands[].heightRatio` **原样沿用**（probe 保证分区穷尽、和恒为 1），不得改写、不得增删、不得补"未识别区" |
   | `typography.sizePx` | `textRows[].logicalHeightPx`，按 `roleHint` 归到角色；同角色取同档 |
   | `radii.radiusPx` | `blocks[].logicalRadiusPx`，仅 `confidence=medium` 时采用，`low` 记 `unknown` |
   | `palette` | `palette[]` 与识别结果主色交叉校验 |

3. **识别工具仍要调用一次**，但 `requirements` 必须同时索要**相对比例**而不是像素值，消除"物理像素还是逻辑像素"的歧义：

   ```text
   Identify UI components, and describe the visual specification: background color or gradient with direction and stops, primary/accent/surface/text colors as hex, text sizes and weights per role, corner radii, icon style (photo/vector/glyph), and the vertical band layout with height ratios. Put every visual fact into global_observations, one fact per item, with the concrete values you can verify from the image. Express every numeric value (font size, corner radius) as a ratio of the image width, never in pixels.
   ```

   识别结果用于组件清单、组件候选、文本内容与视觉描述；**其数值不直接写入 spec**。

4. 既无 probe 证据、也无识别证据的字段写 `"unknown"` 并进 `uncertainties`；禁止从"氛围词"（如"深色渐变"）自行推出色值。

## 四、下游消费

- `others-visual` 阶段 2（Full/Fast 方案设计）：以 `visual_spec_path=stage1/visual-spec.json` 传入 `hmos-d2a-solution-design`，设计文档的配色/字阶/圆角表必须逐项对齐本文件。
- 实现阶段与视觉校准引用设计文档中的同一套值；报告中出现的色值必须能在 `visual-spec.json` 找到出处。

## 五、Controller 校验

`stage-complete 1`（仅 others-visual）与方案设计阶段（others-visual 阶段 2）会校验本文件存在且结构合法：`schemaVersion=1`、`designSource` 与 catalog 一致、`background.kind` 合法、`palette`/`typography`/`textInventory` 非空且每项 `evidence` 非空、`uncertainties` 为字符串数组。缺文件或结构非法时按证据错误拒绝，并指出缺失字段。

`others-visual` 还有四道专属校验：

1. **`inputs-manifest.json`**：`screenshot` 的路径/宽高/字节数/SHA-256 必须与 `source/visual/screenshot.png` 实际一致；`canvas.scale` 必须等于 `physicalWidth / logicalWidth`；必须声明 `visualSpecPath` 与 `visualProbePath`。
2. **`stage1/visual-probe.json`**：`producer.tool` 必须是 `visual_probe`；`source.sha256` 必须与截图一致；`canvas` 必须与 manifest 一致；`budget.passes` 必须为 `1` 且 `withinBudget=true`；`bands` 必须从 `y0=0` 起、`heightRatio` 之和为 `1.0 ± 0.05`；`background.kind=gradient` 时必须有 ≥2 个有序停点且每个是 `#RRGGBB`。
3. **`stage1/component-vision-analysis.json`**：`producer.tool` 必须是 `recognize_ui_components`，`inputs.image.sha256` 必须与截图一致，`inputs.requirements` 的 SHA-256 必须与文本自洽，`schemaVersion`/`status` 与 analysis 形状必须匹配；**`status=degraded` 直接拒绝**，该阶段必须 blocked。

4. **实现保真**（阶段 2 与阶段 4 各校验一次，阶段 5 豁免）：生成页面的 `.fontSize(N)` 必须覆盖 `typography` 里每个数值型 `sizePx`（±1vp），`.borderRadius(N)` 必须覆盖 `radii` 里每个数值型 `radiusPx`（±1vp），页面内不得出现十六进制色值字面量，且 `palette` 的每个色值必须仍能从模块 `color.json` 取到（每通道 ±3）。只查单向——「已确认的值必须出现在代码里」；反向不查，因为设计稿没规定的布局数字本来就该由实现决定。

5. **文本清单**（阶段 1 与阶段 2 各校验一次）：`textInventory` 非空、每条 `text`/`evidence` 非空；未标 `inferred` 的条目（≥2 字）必须能在 `stage1/component-vision-analysis.json` 里找到出处，否则按"编造文案"拒绝；`inferred: true` 的条目必须带 `reason`。阶段 2 另外校验 `generated-ui-manifest.userVisibleStrings` ⊆ `textInventory`，来自 `inferred` 条目的字符串必须在 `inferredStrings` 里声明，出现清单外的字符串即拒绝。
