# HTML 设计源取证契约（others-html）

> 本文件是 `others-html`（HTML 设计源）路径的**唯一取证口径**。阶段 1 必须按此生成 `stage1/layout-facts.json` 与参考集，阶段 2/3/4 只能引用、不得重算、不得手抄数值。
>
> 本文规定本路径的证据口径：输入是 `input.html`，产出是 `layout-facts.json`（数值真值）与参考集（图像真值）；下游所有取值以 facts 为准。

---

## 一、三层产物，职责不重叠

| 产物 | 生产方 | 内容 | 硬约束 |
|---|---|---|---|
| `stage1/layout-facts.json` | **脚本**（`scripts/html-source-capture.mjs`） | 每个节点的 rect + computed style | 全部数值只在这里；颜色保留 CSS 原值（含 `rgba()`），**不折算 hex** |
| `source/html/reference/` | **同一个脚本、同一次会话** | `reference-00..NN.png` 分段截图 + `content-full.png` | 与 facts **同源**产出，不允许拆成两次渲染 |
| `stage1/visual-spec.json` | **Agent** | 只有语义：`roles` / `systemUi` 决策 / `notImplemented` / `unknowns` | **禁止出现任何数值**（字号、颜色、圆角、坐标、比例）；只能引用 `nodeId` |

三者的关系：**facts 是唯一数值真值（实现与修值的依据），spec 只解释语义，参考集提供评分参考帧（`reference-00.png` 参与评分，其余供人工查看）。**

阶段 5 的判据是**主流评分流程**（分数 + `compare_images` 复核，详见 §5.3）；facts 在阶段 5 用于把分数与热力图指出的差异归因到节点与确切修值。**不得**由 facts 推导出节点级结论去关闭或伪造问题。

---

## 二、`layout-facts.json` 结构

```jsonc
{
  "schemaVersion": 1,
  "designSource": "others-html",
  "producer": { "tool": "html_source_capture", "version": 1, "createdAt": "<ISO>" },
  "source": { "path": "source/html/input.html", "sha256": "<64 hex>", "size": 133385 },  // 与 manifest.htmlSource.path 相同；嵌套时为 source/html/<dir>/input.html
  "render": {
    "deviceScaleFactor": 2,
    "viewport": { "width": 360, "height": 792 },
    "canvas": { "logicalWidth": 360, "logicalHeight": 792, "physicalWidth": 720, "physicalHeight": 1584 },
    "content": { "scrollHeightPx": 2888, "extentPx": 2888, "frames": 4, "coverage": 1.0, "visibleCoverage": 1.0 },
    "resources": { "total": 96, "missing": 0, "samples": [] }
  },
  "reference": {
    "dir": "source/html/reference",
    "frames": ["reference-00.png", "reference-01.png", "reference-02.png", "reference-03.png"],
    "contentFull": "content-full.png"
  },
  "nodes": [
    {
      "nodeId": "n0007",
      "tag": "div",
      "cls": "Pixso-rectangle-2_65284",
      "text": null,
      "rect": { "x": 0, "y": 692, "w": 360, "h": 100 },
      "style": {
        "fontSizePx": null,
        "fontWeight": null,
        "fontFamily": null,
        "color": null,
        "backgroundColor": null,
        "borderRadiusPx": [0, 0, 0, 0],
        "linearGradient": { "direction": "to bottom", "stops": [[0, "rgba(241,243,245,0)"], [1, "rgba(0,0,0,0.6)"]] },
        "opacity": 1,
        "backdropFilter": null,
        "mixBlendMode": null,
        "zIndex": 0,
        "imageSrc": null,
        "maskImage": null,
        "maskSize": null,
        "maskPosition": null,
        "backgroundSize": null,
        "backgroundPosition": null,
        "objectFit": null,
        "objectPosition": null,
        "clipPath": null
      }
    }
  ],
  "systemUi": [
    { "nodeId": "n0012", "kind": "status-bar", "reason": "rect 完全落在状态栏区域内且无业务文本" }
  ],
  "uncertainties": []
}
```

### 2.1 字段规则

| 字段 | 规则 |
|---|---|
| `nodeId` | 脚本按 DOM 顺序生成 `n0000…`，**同一份 HTML 必须稳定**（禁止依赖随机数或时间） |
| `rect` | `getBoundingClientRect()` 的 CSS 像素值，保留 2 位小数（即逻辑 vp，不再除以 deviceScaleFactor） |
| `style.color` / `backgroundColor` / 停点 | **原样保留 `rgba()`/`rgb()`**；不转 hex、不丢 alpha、不做颜色合成 |
| `style.fontFamily` | 计算后的字体族；图标字体以此判断（如 `"HM Symbol-Regular"`） |
| `iconGlyph` | 仅图标字体字形节点出现，值为 `true`；此时 `text` 为 `null`，实现时必须按图标处理而不是文字 |
| `style.borderRadiusPx` | 四角数组；读不到时全 0 |
| `style.linearGradient` | 仅当 `background-image` 含 `linear-gradient()` 时产出，`stops` 保留原始颜色串，位置按颜色索引等分；`raw` 字段保留原始 CSS 串 |
| `style.maskImage` / `maskSize` / `maskPosition` | 蒙版三件套（含 `-webkit-` 回退读取）；data-URI 蒙版**原样整串记录**。提取用 `scripts/html-assets-materialize.mjs`，禁止手写 CSS 解析器回读源文件 |
| `style.backgroundSize` / `backgroundPosition` | 计算值（`auto` / `0% 0%` 缺省记 null）；与蒙版配对即可重建裁剪配方 |
| `style.objectFit` / `objectPosition` | 媒体元素内容适配（`fill` / `50% 50%` 缺省记 null） |
| `style.clipPath` | 非空表示该节点用了 clip-path——物化器登记 unknowns，翻译交回模型判断 |
| `systemUi` | 由脚本按几何判据产出（见 2.3），Agent 只能追加条目，**不得删除** |
| `uncertainties` | 脚本层的不可测量项（如 `mix-blend-mode` 的最终效果、`backdrop-filter` 的实际像素） |

### 2.2 节点筛选（保证 < 2 MB）

只收录满足**任一**条件的节点：

- 有非透明 `background-color` 或 `background-image`
- 有边框或圆角
- 是叶子文本节点（`text` 非 null）
- 是 `<img>` / `<svg>` 或带 `background-image` 的资源节点

**排除**：纯布局容器（无背景、无文本、无边框、无圆角）、`display:none`、零尺寸节点。

数值做精度截断（rect 2 位小数、颜色原串）。生成后若 > 2 MB，说明筛选失效，必须收紧而不是截断真相。

### 2.3 `systemUi` 判定（几何判据，脚本产出）

满足以下**全部**条件：

1. `rect` 完全落在 `statusBarHeightVp` 或 `gestureBarHeightVp` 区域内（由 `window` 避让区或工程配置得到）；
2. 节点及其子树**不含业务文本**（文本内容与 App 文案无关，如时间、信号、电量）；
3. 节点没有可点击语义（无 `onclick`、无 `<a>`/`<button>`）。

判不出时**不产出**条目，写进 `uncertainties`，由 Agent 在 `visual-spec.systemUi` 里给出决策与依据。

### 2.4 两个覆盖率必须分开记

设计稿有两种形态，脚本不得假设是哪一种：

| 形态 | 特征 | `coverage` | `visibleCoverage` |
|---|---|---|---|
| **真长页**（可滚动） | 内部滚动容器 `scrollHeight > clientHeight` | = `scrollHeight / 视口高`，≥ 1 | 1（帧覆盖全部内容） |
| **裁剪画板**（不可滚） | `scrollHeight == clientHeight`，但内容 `extentPx` 远超视口 | 1（可见部分已全拍） | `帧数 × 视口高 / extentPx`，**远小于 1** |

字段定义：

- `scrollHeightPx`：设计内部可滚动内容的高度（可滚容器或 document）。
- `extentPx`：设计内容的**实际延伸高度** = `max(nodes[].rect.y + rect.h)`，与能否滚动无关。
- `coverage`：**参考集对可滚动内容的覆盖**，必须 ≥ 1（`frames = ceil(coverage)`）。
- `resources`：本阶段扫到的本地引用条数与**无法在冻结树内兑现**的条数，分三类——`root-absolute`（`/x.png` 在 `file://` 下指向磁盘根）、`outside-tree`（`file:///` 或 `../` 逃出 `source/html/`）、`missing`（文件不存在）。本地引用 **≥5 条**且 `missing/total ≥ 0.5` 时取证脚本直接 exit 2（少于 5 条时缺失率高是常态，只告警不拦）；`> 0.25` 时阶段 1 不成立——参考帧是缺图渲染的，不能拿来当视觉真值。`remote` 是跳过的远程引用数（不冻结）。
- `visibleCoverage`：**参考集对设计内容全高的覆盖**，等于 `min(1, frames × 视口高 / extentPx)`。

**实测样例**：Pixso 导出的照片日视图是裁剪画板——`scrollHeightPx=792`、`extentPx=2888`、`frames=1`、`coverage=1`、`visibleCoverage=0.2742`。也就是说 **73% 的设计内容只有 facts、没有视觉参考**。

这条不是缺陷，是这类导出格式的固有属性：布局真值来自 DOM/CSS（facts 覆盖 100%），视觉参考只覆盖首屏。因此：

- 阶段 2/3/4 的所有取值必须走 facts，**不得用"参考图里看不到"作为不实现的理由**；
- 阶段 5 的评分只看首帧（`reference-00.png`）。`visibleCoverage < 1` 时该分数**只代表首屏**，未覆盖部分靠阶段 2 的 facts 直译保证，不在阶段 5 复检，也不得用整页长图补齐覆盖率；总结呈现校准结论时须同时写出 `visibleCoverage`（提示该分数的覆盖范围），不得用"已校准"掩盖参考图覆盖不足。

---

## 三、参考集规则（禁止 `fullPage`）

| 规则 | 说明 |
|---|---|
| **禁用 `fullPage: true`** | 页面自带内部滚动容器时 `fullPage` 只返回视口高度，参考帧必须逐屏截取 |
| 首帧 `reference-00.png` | viewport = 逻辑画布（默认 360×792）、`deviceScaleFactor=2`，严格等于设备首屏 |
| 后续帧 | 把设计内部**最外层可滚动容器** `scrollTo(0, k × viewportHeight)` 后截图，每屏吸顶/吸底元素位置正确 |
| `content-full.png` | 各帧纵向拼接，**只用于人类查看与覆盖核对**；因吸顶元素会重复，**禁止参与任何像素比较** |
| `coverage` | `scrollHeightPx / viewportHeightPx`，必须 ≥ 1.0 且帧数 = `ceil(coverage)` |
| 稳定性 | 每帧截图前等待 `document.fonts.ready` + 两帧 `requestAnimationFrame`，禁止用固定 `sleep` 代替 |

---


### 3.1 两张"整页图"，用途完全不同

| 文件 | 怎么来的 | 等价性 | 能当证据吗 |
|---|---|---|---|
| **`content-full.png`** | 各参考帧纵向拼接 | **等价**（就是各帧拼起来） | 可以看。裁剪画板只有 1 帧，它等于首屏 |
| **`content-unclipped.png`** | 覆盖画板的裁剪（`height:auto; overflow:visible`）后整页截图 | **不等价**：布局会重排 | **禁止**，见下 |

**为什么需要第二张**：设计稿常常把画板高度写死（如 792px）+ `overflow:hidden`，内容却延伸到 2888px。这类"裁剪画板"页面根本不可滚，参考帧只能拍到首屏——**剩下的内容只有 facts、没有图**，人做验收时看不见。

**为什么它不能当证据**：解除裁剪后布局会变，典型表现：

- 照片日视图：内容 2888px，图片 724×5776，宽度漂移 **+4px**
- 负一屏助手：内容 1538px，**内容宽变成 574px（原 360）**，宽度漂移 **+428px**

宽度漂移就足以说明：吸底/吸顶元素位置、百分比高度、居中关系全都变了。它只能回答"被裁掉的部分里有什么"，不能回答"那部分长什么样才对"。

**硬约束**：

- `content-unclipped.png` **只能由人查看**；阶段 4/5 的任何核对、评分、像素比较**不得引用它**。
- 评分参考图只能是 `reference-00.png`；`content-full.png` 与 `content-unclipped.png` 都不得作为 `referenceImage`，也不得作为候选图。
- Controller 会对上述两条做断言（报告里出现这两个文件名即拒）。
- 若解裁失败（找不到裁剪器、超出高度上限、解裁后未变高），`reference.unclipped` 写 `available:false` + `reason`，**不阻塞阶段**。
## 四、`visual-spec.json` 瘦身结构

```jsonc
{
  "schemaVersion": 1,
  "designSource": "others-html",
  "producer": { "kind": "html-facts-semantics" },
  "canvasIncludesSystemBar": true,
  "roles": [
    { "role": "page-title", "nodeId": "n0007", "note": "顶部标题『今天』" }
  ],
  "systemUi": [
    { "nodeId": "n0012", "decision": "not-implemented", "basis": "系统状态栏，由系统绘制，不得回填假 UI" }
  ],
  "notImplemented": [
    { "nodeIds": ["n0030"], "reason": "设计稿无对应后续页面，静态呈现" }
  ],
  "unknowns": [
    { "item": "line-height", "basis": "CSS 未显式声明，且未由 facts 测得" }
  ]
}
```

### 4.1 允许与禁止

| 允许 | 禁止 |
|---|---|
| `role` 命名（把 `n0007` 标成 `page-title`） | 写 `fontSize: 26` 之类的**任何数值** |
| `systemUi` 决策（`not-implemented` / `implemented-as-design`） | 修改 facts 里的数值来表达"我认为应该是 24" |
| `notImplemented` / `unknowns` 及依据 | 用 `uncertainties` 豁免硬约束（不得用它绕过对账） |

**`canvasIncludesSystemBar`（顶层布尔）**：设计画板是否包含系统栏带。阶段 1 必写；必须与 `layout-facts.json.render.statusBarVp > 0` 一致（有栏 `true`、无栏 `false`），不得用数字表达。阶段 2 据此决定页面原点与窗口是否沉浸；旧 run 缺该字段时按 `statusBarVp > 0` 推导。

**数值争议的唯一合法出口**：在 `unknowns` 里写明"facts 测得 X，但依据 Y 判断实现应为 Z"，并在阶段 2 的设计文档里显式记录差异；**不得改 facts**。

**粒度约束**：`roles` 只登记**组件粒度**的角色（页首、卡片行、底栏、空状态这类可复用分组），目标每页 ≤20 条。同一卡片内的装饰部件（头像的每一层、小色条、小图标）合并为一条，`note` 写数量与构成（如"头像 6 层装饰件"），**不逐节点命名**——下游组件树要的是十几组，不是上百条改名。

**systemUi 决策由 Controller 推导复核**：`facts.systemUi[].kind`（`status-bar` / `gesture-bar`）+ 需求澄清的 `systemUiPreference`（含 `userOverrides`）唯一确定常规答案——`drawStatusBar` / `drawGestureBar` 为 `false` 即 `not-implemented`，为 `true` 即 `implemented-as-design`。spec 里写的决策与推导不一致会被拒；只有脚本没分类的节点（facts 无 systemUi 条目、或 kind 未知）才需要你判断并给 `basis`。

---

## 五、取值与修值口径（阶段 2 取值核对、阶段 5 查表修值）

### 5.1 比对项与容差（阶段 2 实现核对用；阶段 5 只用来确定修多少）

| 项 | 来源 | 容差 |
|---|---|---|
| `rect.x/y/w/h` | facts `nodes[].rect` | ±1 vp |
| `fontSizePx` | facts `style.fontSizePx` | ±1 vp |
| 圆角 | facts `style.borderRadiusPx`（四角，顺序 TL, TR, BR, BL） | **先归一化** `min(radius, h/2)` 再比，±1 vp；四角不等时按角落地（`.borderRadius({ topLeft, topRight, bottomRight, bottomLeft })`），不得用同一个值覆盖四角 |
| 文本颜色 / 背景色 | facts `style.color` / `backgroundColor` | 每通道 ±3；**含 alpha 时 alpha 也参与比较（±0.02）** |
| 文本内容 | facts `nodes[].text` | 严格相等（去首尾空白）；`systemUi` 豁免节点除外 |
| `systemUi` 节点 | facts `systemUi` + 用户偏好（Controller 推导复核） | 决策为 `not-implemented` 的**不得在实现中出现**；其文本与字号不参与阶段 2 落地核对（Controller 按避让带几何复算豁免，追加条目骗不过复算） |

### 5.2 差异分类（必须三分类，禁止静默取一边）

| 类别 | 含义 | 处置 |
|---|---|---|
| `code-missing` | facts 有、实现没有 | 必须修实现 |
| `code-extra` | 实现有、facts 没有 | 必须修实现或写进 `notImplemented` |
| `doc-likely-wrong` | facts 与设计文档冲突，且怀疑文档/沿用值错 | 回查 CSS 原文，**允许判定 facts 之外的结论，但必须记录依据** |

### 5.3 判据归属

**阶段 5 的判据是主流评分流程（分数 + `compare_images` 复核），facts 是归因真值。**

- **主判据**：与 figma / pixso / mastergo / lanhu / others-visual 一致的评分制——每轮 `score.json` 的 `aggregate.final_baseline_score` ≥ `scoreThreshold`（缺省 80）即收尾，轮次上限 `maxRounds`（缺省 5）。分数与轮次是**兜底与进度信号**，不是质量验收（验收以人工评审为准）；修复与重建证据按主流评分流程的「下一轮准入」执行。
- **facts 是归因真值**：分数与热力图告诉你**哪里**不对；5.1 的容差表与挂出的 facts 节点给出确切目标值（"往上挪一点" → "h=118.66，实测 112"），修复按它取数。这是本来源相对主流位图路径的最大增量。
- **区域体系已退役为可选诊断**：`html-frame-regions.mjs` 的区域差异与 `--probe` 点采样只在定位争议时使用，不作判据、不拦截收尾（详见能力 `hmos-d2a-html-to-arkui` 的阶段 5 诊断工具一节）。
- **已废弃的口径**（三条，均不要再引入）：①"节点级对账未闭合项归零"——HTML 的 DOM 层级不承载布局语义（约 44% 的 div 是绝对定位），节点无法与 ArkUI 组件一一对应；②"区域清单 + 复核筛选（triage）"——工程上脆弱（拼图脚本曾因大图崩溃引发连锁排障），检出能力与成本不成正比；③"把像素分当质量判据"——实测同一对图只改忽略区，分数只在 86.0–88.1 之间动，4 处可见缺陷合计约 1 分，噪声却有 ±2 分；分数只作兜底停机与跨轮进度信号。

---

## 六、通用性边界（脚本对"任意 HTML"的适应范围）

`html-source-capture.mjs` **不依赖任何导出器的类名、结构或命名约定**：它只读 DOM 与 computed style，不看 class 名、不认 `Pixso-*` 前缀、不读 `data-*` 语义。Pixso / Figma / MasterGo / 手写 HTML 走同一条路径。

### 6.1 已覆盖

| 场景 | 处理方式 |
|---|---|
| **文档级滚动**（`body` 撑高、无内部滚动容器） | `scrollContainer=document`，按视口步进滚动 `window` |
| **单一内部滚动容器**（如设计工具导出的画板） | `scrollContainer=design-element` |
| **多个纵向滚动容器** | 按**可滚动量最大**者选主容器（不按 DOM 顺序），短侧栏不会被误选 |
| **懒加载图片**（`loading="lazy"`） | 测量前强制 `eager` + `decode()`（5s 上限），未完成解码的会写进 `uncertainties` |
| **任何画布尺寸** | 宽高与像素比全部由参数传入，不内置机型假设 |
| **横向溢出** | 记录 `render.horizontalOverflowPx` 并写进 `uncertainties`（见 6.2） |
| **颜色 / 渐变 / 圆角 / 边框 / 文本 / 媒体** | 全部从 computed style 取，保留 `rgb()/rgba()` 原值 |
| **图标字体**（文本是私有区码位，`font-family` 指向 symbol 字体） | 标记 `iconGlyph: true`、`text` 置空，并写进 `uncertainties`；不会被阶段 2 的文本对账要求复现 |

### 6.2 明确不支持（会在 `uncertainties` 里报出来，或直接失败）

| 场景 | 行为 |
|---|---|
| **Shadow DOM** | 不遍历。脚本会统计 shadow host 数量并写进 `uncertainties`；节点会缺失，必须人工核对 |
| **iframe 内部** | 不遍历，同上统计并提示 |
| **横向滚动** | 只记录溢出宽度，**不逐屏截取横向帧**；横向可滚动的设计需要人工补参考图 |
| **超过 32 屏** | 直接失败退出（防止把多页文档当成单页设计）；确实需要时改脚本或用别的取证方式 |
| **canvas / video 内部像素** | 只记录节点框，不记录内容 |
| **`display:none` / `opacity:0`** | 被排除（不在 facts 里）；这类隐藏态需要人工确认是否应实现 |
| **动画 / 过渡 / 轮播** | 只保证测量瞬间的状态；无限动画可能导致帧间不一致 |
| **closed shadow root** | 连 host 都探测不到（浏览器不暴露），属于脚本能力之外 |

### 6.3 使用前提

- 必须传 `--viewport-width` / `--viewport-height`（默认 360×792 只适合手机稿）。**传错尺寸得到的 facts 是错的，但不会报错**——这是本条最需要人工确认的地方。
- `--status-bar-vp` / `--gesture-bar-vp` 不传时不做系统 UI 分类，`systemUi` 为空，改由 `visual-spec.systemUi` 人工判定。
## 七、禁止事项

- 不得把 facts 的数值手抄进 `design-doc.md` 之外的任何中间文件后再回引（避免二次转写失真）。
- 不得在阶段 1 之后重新渲染或重新 dump facts；facts 与参考集在阶段 2 确认时进入快照，之后改动即视为破坏基线。
- 不得用"识别工具/模型目测"替代 facts 的任何数值。
- 不得用 `fullPage` 截图；不得裁剪后再与参考图整体比较。**区域裁片只是阶段 5 的诊断辅助**（脚本按 bbox 生成编号拼图），且必须由脚本按 `regions.json` 的 bbox 生成，不得手工裁剪另造对比图。
- 不得为了让对账通过而修改 `layout-facts.json`。
