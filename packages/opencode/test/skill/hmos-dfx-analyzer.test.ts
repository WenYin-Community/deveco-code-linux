import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// SR1 统一能力结构测试：DFX 主 Skill（hmos-dfx-analyzer）是 Registry 中唯一的 DFX Skill，
// 三个专项 Analyzer 以 references/*/analyzer.md 形式内聚在主 Skill 内，不再作为独立 Skill 存在
// （FR-16 / AC-18）。Discovery 只注册 **/SKILL.md，因此本测试通过钉板资源目录结构来守护该约定。

const skillDir = path.resolve(import.meta.dir, "../../resources/skills/hmos-dfx-analyzer")

function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(root, full).replaceAll("\\", "/"))
    }
  }
  walk(root)
  return out.toSorted()
}

function readLines(rel: string): string[] {
  return fs.readFileSync(path.join(skillDir, rel), "utf-8").split("\n")
}

describe("hmos-dfx-analyzer skill structure (FR-16 / AC-18)", () => {
  test("exactly one SKILL.md exists: the main skill entry", () => {
    const files = listFiles(skillDir)
    const skillMds = files.filter((f) => f === "SKILL.md" || f.endsWith("/SKILL.md"))
    expect(skillMds).toEqual(["SKILL.md"])
  })

  test("three internal analyzers use analyzer.md entries at the fixed routes", () => {
    const routes = [
      "references/appfreeze/analyzer.md",
      "references/cppcrash/analyzer.md",
      "references/jscrash/analyzer.md",
    ]
    const files = listFiles(skillDir)
    for (const route of routes) {
      expect(files).toContain(route)
    }
  })

  test("legacy standalone dfx skill names are not registered anywhere", () => {
    const files = listFiles(skillDir)
    for (const file of files) {
      expect(file.startsWith("dfx-appfreeze-analyzer/")).toBe(false)
      expect(file.startsWith("dfx-cppcrash-analyzer/")).toBe(false)
      expect(file.startsWith("dfx-jscrash-analyzer/")).toBe(false)
    }
    expect(fs.existsSync(path.resolve(skillDir, "../dfx-appfreeze-analyzer"))).toBe(false)
    expect(fs.existsSync(path.resolve(skillDir, "../dfx-cppcrash-analyzer"))).toBe(false)
    expect(fs.existsSync(path.resolve(skillDir, "../dfx-jscrash-analyzer"))).toBe(false)
  })

  test("main skill frontmatter declares name hmos-dfx-analyzer", () => {
    const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")
    expect(content.startsWith("---\n")).toBe(true)
    expect(content).toContain("name: hmos-dfx-analyzer")
    const end = content.indexOf("\n---\n", 4)
    expect(end).toBeGreaterThan(0)
  })

  test("analyzer entries carry no skill frontmatter (not discoverable as skills)", () => {
    for (const route of [
      "references/appfreeze/analyzer.md",
      "references/cppcrash/analyzer.md",
      "references/jscrash/analyzer.md",
    ]) {
      const content = fs.readFileSync(path.join(skillDir, route), "utf-8")
      expect(content.startsWith("---")).toBe(false)
      expect(content).toContain("由 DFX 主 Skill（hmos-dfx-analyzer）")
    }
  })

  test("delivery routing rules live only in the main skill (真值源，无复制维护)", () => {
    // 交付路由（会话内只回摘要 / 报告落盘 HTML / export_report.py 调用规范）
    // 由 SKILL.md「呈现与交付」唯一承载；Analyzer 输出格式章节只定义报告正文的
    // 内容结构。三个 analyzer.md 不得出现交付路由措辞，防止真值源漂移。
    for (const route of [
      "references/appfreeze/analyzer.md",
      "references/cppcrash/analyzer.md",
      "references/jscrash/analyzer.md",
    ]) {
      const content = fs.readFileSync(path.join(skillDir, route), "utf-8")
      expect(content).not.toContain("export_report.py")
      expect(content).not.toContain("不在会话中输出全文")
      expect(content).not.toContain("会话内只保留简洁摘要")
      expect(content).not.toContain("dfx-reports")
    }
    const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")
    expect(skill).toContain("交付路由规则由本节唯一承载（真值源）")
    expect(skill).toContain("仅定义报告正文的**内容结构**")
  })

  test("FILES.md whitelist lists the three analyzers, the identify script and the export script", () => {
    const files = listFiles(skillDir)
    expect(files).toContain("FILES.md")
    const content = fs.readFileSync(path.join(skillDir, "FILES.md"), "utf-8")
    expect(content).toContain("references/appfreeze/analyzer.md")
    expect(content).toContain("references/cppcrash/analyzer.md")
    expect(content).toContain("references/jscrash/analyzer.md")
    // SR1 v1.8+: non-crashing white screens are in scope (ported from the
    // upstream runtime-fix skill enhancement) — symptom-routed analyzer.
    expect(content).toContain("references/white-screen/analyzer.md")
    expect(content).toContain("scripts/identify_fault_log.py")
    expect(content).toContain("scripts/export_report.py")
    // SR1 v1.8 fusion: device-side collection scripts migrated from
    // hmos-runtime-fix-skill live under scripts/collect/.
    expect(content).toContain("scripts/collect/jscrash-report.mjs")
    expect(content).toContain("scripts/collect/parse-jscrash-log.mjs")
    expect(content).toContain("scripts/collect/collect-hilog.mjs")
    expect(content).toContain("scripts/collect/shared/jscrash-parse.mjs")
  })

  test("SKILL.md companion file list matches the FILES.md whitelist set", () => {
    // SR1 v1.8.x: 市场副本（harmonyos-agent-skills）无 FILES.md——那是 DevEco Code
    // 宿主私有的加载白名单约定，已按检视意见移除；配套文件清单改由 SKILL.md
    // 「配套文件清单」节承载。两处必须保持同一集合，防止后续加文件只改一处。
    const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")
    expect(skill).toContain("## 配套文件清单")
    const section = skill.slice(skill.indexOf("## 配套文件清单"))
    const listed = [...section.matchAll(/^- (\S+)$/gm)].map((m) => m[1])
    const whitelist = fs
      .readFileSync(path.join(skillDir, "FILES.md"), "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("@"))
    expect(listed).toEqual(whitelist.toSorted())
  })

  test("analyzer scripts migrate intact next to their analyzer.md", () => {
    const files = listFiles(skillDir)
    expect(files).toContain("references/cppcrash/scripts/main.py")
    expect(files).toContain("references/appfreeze/scripts/sample_stack_analyzer.py")
    expect(files.some((f) => f.startsWith("references/jscrash/scripts/hstack/"))).toBe(true)
    expect(files).toContain("scripts/identify_fault_log.py")
    expect(files).toContain("scripts/export_report.py")
  })
})

describe("hmos-dfx-analyzer read-completeness guards (design 4.4)", () => {
  // read 工具单次读取上限：2000 行、单行 2000 字符。入口文件必须一次可读全，
  // 否则主 Skill 的“读取至 EOF”防护形同虚设。
  test("entry files fit within one read (2000 lines, 2000 chars per line)", () => {
    for (const file of [
      "SKILL.md",
      "references/appfreeze/analyzer.md",
      "references/cppcrash/analyzer.md",
      "references/jscrash/analyzer.md",
      "references/white-screen/analyzer.md",
    ]) {
      const lines = readLines(file)
      expect(lines.length).toBeLessThan(2000)
      const longest = lines.reduce((acc, line) => Math.max(acc, line.length), 0)
      expect(longest).toBeLessThan(2000)
    }
  })
})

describe("hmos-dfx-analyzer main skill content invariants (SR1 flow migration)", () => {
  const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")

  test("fixed analyzer routing table is the single source of truth", () => {
    expect(content).toContain("references/appfreeze/analyzer.md")
    expect(content).toContain("references/cppcrash/analyzer.md")
    expect(content).toContain("references/jscrash/analyzer.md")
    expect(content).toContain("references/white-screen/analyzer.md")
    expect(content).toContain("唯一真值源")
  })

  test("non-crashing white screens route to the source-first analyzer (ported from runtime-fix)", () => {
    // 症状入口先做白屏存活判定：进程存活、界面空白 → source-first，不进采集死循环
    expect(content).toContain("白屏存活判定")
    expect(content).toContain("不进入设备侧采集")
    // 采集无 crash 日志且症状为空白存活 → 切白屏路径，不判定运行时健康
    expect(content).toContain("采集无果切白屏路径")
    // no_crash_signature 死循环防护（上游修复核心）：hilog 解析无崩溃签名 ≠ 运行时健康
    expect(content).toContain("no_crash_signature")
    expect(content).toContain("不得据此判定运行时健康")
    // 崩溃型白屏（白屏后退出）仍走崩溃采集链路
    expect(content).toContain("白屏后退出")
    // 白屏 analyzer 的验证契约：build 成功不等于白屏修复
    const analyzer = fs.readFileSync(path.join(skillDir, "references/white-screen/analyzer.md"), "utf-8")
    expect(analyzer).toContain("hideNavBar(true)")
    expect(analyzer).toContain("NavDestination")
    expect(analyzer).toContain("devecocli docs search")
    expect(analyzer).toContain("根因匹配")
    expect(analyzer).toContain("构建验证")
    expect(analyzer).toContain("运行时验证")
  })

  test("collect parser next-action text diverts blank-alive cases away from the log-retry loop", () => {
    // 实测回归防护：no_crash_signature 的 next-action 曾指示"要更完整的崩溃日志"，
    // 白屏类故障会被推回采集死循环——脚本侧与 SKILL.md 双层堵死
    const parser = fs.readFileSync(path.join(skillDir, "scripts/collect/shared/jscrash-parse.mjs"), "utf-8")
    expect(parser).toContain("white-screen source-first flow")
    expect(parser).not.toContain("Ask for a fuller crash log, a clearer repro, or optionally")
  })

  test("deterministic identify script invocation is mandated before analysis", () => {
    expect(content).toContain("identify_fault_log.py")
    expect(content).toContain("--stdin")
    expect(content).toContain("存在日志证据时必须执行识别脚本")
  })

  test("triage flow, clarification and delivery rules migrated from the subagent prompt", () => {
    expect(content).toContain("结果处置决策表")
    expect(content).toContain("领域词汇归一表")
    expect(content).toContain("候选回退上限为一次")
    expect(content).toContain("分诊结论被用户反驳")
    expect(content).toContain("分诊结论：<type>；输入完整度：<completeness>；置信度：<confidence>")
    expect(content).toContain("不得高于分诊置信度")
    expect(content).toContain("源码修改状态")
  })

  test("fix-intent tail status wording is pinned, no freestyle read-only disclaimers (FR-27)", () => {
    expect(content).toContain("交付状态措辞钉板")
    expect(content).toContain("未执行，由主 Agent 承接")
    expect(content).toContain("是否需要按照上面的诊断结论修改并验证？")
    // Forbidden freestyle tails observed in the wild must be explicitly banned.
    expect(content).toContain("只读模式")
    expect(content).toContain("请手动将修复方案应用到代码")
    expect(content).toContain("不得请求用户自行修改代码")
  })

  test("analyzer loading rules enforce single-load, EOF and base-dir semantics", () => {
    expect(content).toContain("只加载路由命中的那一个")
    expect(content).toContain("读取至 EOF")
    expect(content).toContain("ANALYZER_BASE_DIR")
  })

  test("sub-session entries are declared and self-load path is closed (SR1 v1.6)", () => {
    // The skill is session-agnostic — any loader follows the same analysis
    // flow. No "who are you" routing, no self-load prohibition.
    expect(content).toContain("会话无关的分析流程")
    expect(content).toContain("技能加载")
    expect(content).not.toContain("引文区块")
    // Delivery pinning lives in the skill: concise in-session summary plus a
    // local HTML report written by the export script.
    expect(content).toContain("会话内简洁摘要")
    expect(content).toContain("会话内摘要钉板")
    expect(content).toContain("export_report.py")
    expect(content).toContain("dfx-reports/dfx-report-<type>-<时间戳>.html")
    // SR1 v1.8 fusion: symptom-only entry collects device-side evidence inside
    // the sub-session (deterministic triage mandatory), and js_crash reports
    // carry minimal-fix execution constraints executed by the main agent
    // (the repair plan itself is the analyzer body's repair-suggestion section).
    expect(content).toContain("症状入口与采集流程")
    expect(content).toContain("必须过识别脚本定类，不得按症状预设故障类型")
    expect(content).toContain("scripts/collect/collect-hilog.mjs")
    expect(content).toContain("scripts/collect/parse-jscrash-log.mjs")
    // 非崩溃型白屏（缺口 3 修订）：按上游 runtime-fix 增强移植为 source-first
    // 受理路径——症状入口先做白屏存活判定，采集无果切白屏路径，不死循环。
    expect(content).toContain("白屏存活判定")
    expect(content).toContain("采集无果切白屏路径")
    expect(content).toContain("不得进入\"证据不足请重试\"的死循环")
    // 批量合并报告分节契约（实测回归：批量报告曾自创压缩结构，三级根因定位等章节缺失、
    // 分诊摘要表丢输入完整度）——每份日志完整遵循 Analyzer 输出格式章节，摘要表
    // 逐份携带 类型/输入完整度/置信度 三协议字段
    expect(content).toContain("分节契约")
    expect(content).toContain("完整遵循该类型 Analyzer")
    expect(content).toContain("契约章节逐份必备")
    // 报告正文传输入口：--input 文件参数优先，绕过 shell 管道编码
    // （实测回归：PowerShell 5.1 的 Get-Content 对无 BOM UTF-8 文件按 ANSI 解码，
    // 报告在进 Python 前即乱码，PYTHONIOENCODING 无法挽回）
    expect(content).toContain("--input")
    expect(content).toContain("Windows/PowerShell 禁用")
    // 分节首行 = 该份分诊结论行（实测回归：一次批量运行只在摘要表逐份给行，
    // 各分节开头缺分诊结论，用户无法逐份速览类型/完整度/置信度）
    expect(content).toContain("分节首行为该份的分诊结论行")
    expect(content).toContain("类型 / 输入完整度 / 置信度")
    expect(content).toContain("三项不得缺")
    expect(content).toContain("修复执行约束（仅 js_crash 报告")
    expect(content).toContain("报告驱动、主 Agent 执行")
    expect(content).toContain("不重复产出")
    expect(content).toContain("最小修复")
    // SR1 v1.8 final: the routing preamble is removed — the skill is
    // session-agnostic; whoever loads it follows the same analysis flow.
    // No "who are you" branching, no delegation instruction.
    expect(content).not.toContain("执行环境判定")
    expect(content).not.toContain("不要在本会话执行本技能")
    expect(content).toContain("会话无关的分析流程")
    // 加载即执行：主 Agent 已加载本技能则直执到底，不再委派 dfx（双重加载防护）
    expect(content).toContain("加载即执行")
    expect(content).toContain("不再委派 dfx 子代理")
    // 摘要即主会话最终输出：markdown 结构（## 标题 + **字段** + 行内代码），按 **字段** 解析；
    // 含下划线标识符一律行内代码包裹——行内代码不参与强调解析，规避流式渲染中词内下划线
    // 被误配成斜体（暗黄残影，实测回归），同时防止主 Agent 改写路径与格式。
    expect(content).toContain("## DFX 故障分析结论")
    expect(content).toContain("**故障基本信息**")
    expect(content).toContain("| 项目 | 内容 |")
    expect(content).toContain("| 故障时间 |")
    expect(content).toContain("| 故障进程 |")
    expect(content).toContain("| 故障事件 |")
    expect(content).toContain("**故障类型**：`<type>`（置信度 <confidence>）")
    expect(content).toContain("**根因分析**：<1~3 句")
    expect(content).toContain("**修复建议**：<1~2 句修复方向")
    expect(content).toContain("**分析报告**：`<HTML 绝对路径>`")
    expect(content).toContain("含下划线的标识符一律用行内代码包裹")
    expect(content).toContain("片段等证据缺失的字段对应表格行省略")
    expect(content).toContain("请原样输出——不得增删行、重新排版或改写措辞")
    expect(content).toContain("不得改写为相对路径")
    expect(content).toContain("禁止改写为相对路径")
    expect(content).toContain("上下文卫生")
    // 超限处置规则钉板（实测回归 ses_f1a66413：超限后 agent 即兴发挥，花 5 分钟读源码自证采样
    // 等价性后问用户，用户选终止后主 Agent 又自行裁剪重交）
    expect(content).toContain("脚本执行失败（超限）")
    expect(content).toContain("不加载 Analyzer，不自行读源码自证")
    expect(content).toContain("不得以任何方式补救重试")
  })

  test("script output is intermediate evidence and must not leak Chinese into non-Chinese reports", () => {
    // Scripts (identify + analyzers) always emit Chinese; the model must
    // re-organize in the user's language instead of copying Chinese output.
    expect(content).toContain("语言约束（会话摘要与 HTML 报告同受约束）")
    expect(content).toContain("中间证据")
    expect(content).toContain("不得将脚本的中文输出原文复制进非中文交付")
    // Protocol labels in the triage summary line stay pinned regardless of language.
    expect(content).toContain("协议字段")
  })

  test("trailing self-appended content follows the report language (batch tail regression)", () => {
    // Batch merged reports used to gain freestyle English tails. The tail is
    // part of the report: same language as the whole report, no mid-report
    // language switch, original-text exceptions unchanged, and no
    // self-authored root cause / repair suggestions smuggled in via the tail.
    expect(content).toContain("末尾追加内容同受语言约束")
    expect(content).toContain("含批量合并报告的收尾")
    expect(content).toContain("与整份报告保持同一语言")
    expect(content).toContain("不得中途切换语言")
    expect(content).toContain("只能汇总已加载 Analyzer 已产出的结论")
    expect(content).toContain("不得借此自行补写新的根因或修复建议")
    // 实测回归（cppcrash 报告曾自行追加"是否需要进一步分析"+ 勾选清单）：
    // 报告是静态交付物，模板外顶层章节与向用户提问/选项清单一律禁止。
    expect(content).toContain("严禁新增模板之外的顶层章节")
    expect(content).toContain('"是否需要进一步分析"式的收尾提问')
    expect(content).toContain("不得向用户提问、")
    expect(content).toContain("征询意见或罗列后续分析选项")
  })

  test("batch input scope rules are pinned (FR-05/FR-07 v1.5)", () => {
    expect(content).toContain("批量场景")
    // All-logs intent truth source: user's original words only (delegation
    // quote-block source removed in v1.5).
    expect(content).toContain("仅限**用户原话**")
    expect(content).toContain("视为未明确范围")
    // Unclear scope must be confirmed; no defaults either way.
    expect(content).toContain("确认**分析范围**")
    expect(content).toContain("不得默认")
    // Cross-type grouped delivery is an explicit exception to single-load.
    expect(content).toContain("例外")
    expect(content).toContain("合并报告")
  })

  test("sample stack (enhanced log) companion-evidence rules are pinned", () => {
    // 采样栈是冻屏分析的配套证据：分诊判为 sample_stack，单独提供时索取
    // faultlog，与冻屏 faultlog 同给时归并传入 appfreeze Analyzer。
    // 仅钉板主 Skill（我们的分诊层）行为；appfreeze Analyzer 内部如何消费
    // 采样栈路径由其自身 analyzer.md 定义，不在本测试范围。
    expect(content).toContain("sample_stack")
    expect(content).toContain("配套证据归并与传递")
    expect(content).toContain("freeze-cpuinfo-ext-")
    expect(content).toContain("采样栈变体")
    expect(content).toContain("采样栈（增强日志）不计入独立日志")
    expect(content).toContain("不参与规则 6 的候选计数")
    expect(content).toContain("不参与任何 Analyzer 的入口断言")
    expect(content).toContain("Step 8 使用")
    // Official spec: one event yields at most one sample stack; device-side
    // dirs differ between faultlog (faultlogger/) and sample stack (freeze_ext/);
    // HarmonyOS 6.1.0.125+ merges sample stack into the faultlog tail.
    expect(content).toContain("最多产生一份")
    expect(content).toContain("freeze_ext")
    expect(content).toContain("合并到 faultlog 文件结尾")
    expect(content).toContain("毫秒级时间戳")
  })
})
