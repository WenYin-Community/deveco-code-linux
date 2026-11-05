import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

// export_report.py 是 DFX 主 Skill 的 HTML 报告落盘脚本（SR1 v1.7 评审决策）：
// 会话内只保留简洁摘要，完整报告写入 <启动目录>/dfx-reports/ 下的
// 自包含 HTML（代码高亮 + diff 渲染）。本测试通过子进程钉板其行为契约。
// 运行依赖 python3；不可用时整组跳过。

const SCRIPT = path.resolve(import.meta.dir, "../../resources/skills/hmos-dfx-analyzer/scripts/export_report.py")

function pythonAvailable(): boolean {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf-8" })
  return probe.status === 0
}

const hasPython = pythonAvailable()

const SAMPLE_MD = [
  "# 一、分诊结论",
  "",
  "故障类型为 **JSCrash**，`Index.ets` 第 14 行读取了 undefined 的属性。",
  "",
  "| 项目 | 值 |",
  "|---|---|",
  "| 完整度 | full |",
  "",
  "## 二、根因分析",
  "",
  "```ts",
  "// entry/src/main/ets/pages/Index.ets",
  'const key = "profile"',
  "const name = user[key].name",
  "```",
  "",
  "## 三、修复建议",
  "",
  "```diff",
  "- const name = user.profile.name",
  '+ const name = user.profile?.name ?? ""',
  "```",
].join("\n")

describe.skipIf(!hasPython)("hmos-dfx-analyzer export_report.py HTML 报告落盘", () => {
  test("markdown 报告导出为自包含 HTML：高亮、diff、表格、类型徽标", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-"))
    try {
      const proc = spawnSync(
        "python3",
        [SCRIPT, "--type", "js_crash", "--title", "测试报告", "--output-dir", dir],
        { input: SAMPLE_MD, encoding: "utf-8" },
      )
      expect(proc.status).toBe(0)
      const printed = proc.stdout.trim()
      expect(printed.startsWith(dir)).toBe(true)
      expect(printed).toContain("dfx-report-js_crash-")
      expect(printed.endsWith(".html")).toBe(true)

      const html = fs.readFileSync(printed, "utf-8")
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("测试报告")
      expect(html).toContain("ArkTS/JS 崩溃（JSCrash）")
      expect(html).toContain('class="tok-kw"')
      expect(html).toContain('class="tok-com"')
      expect(html).toContain('class="tok-str"')
      expect(html).toContain('class="diff-ins"')
      expect(html).toContain('class="diff-del"')
      expect(html).toContain("<table>")
      expect(html).toContain("<code>Index.ets</code>")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("缺省 --output-dir 时落盘到 cwd 下 dfx-reports（启动工程目录约定）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-default-"))
    try {
      const proc = spawnSync("python3", [SCRIPT, "--type", "cpp_crash"], {
        input: "# 报告\n\n内容",
        encoding: "utf-8",
        cwd: dir,
      })
      expect(proc.status).toBe(0)
      const printed = proc.stdout.trim()
      expect(printed).toContain(path.join(dir, "dfx-reports"))
      expect(fs.existsSync(printed)).toBe(true)
      expect(fs.readFileSync(printed, "utf-8")).toContain("Native 崩溃（CppCrash）")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("报告为空时仍生成合法 HTML 文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-empty-"))
    try {
      const proc = spawnSync("python3", [SCRIPT, "--type", "unknown", "--output-dir", dir], {
        input: "",
        encoding: "utf-8",
      })
      expect(proc.status).toBe(0)
      const printed = proc.stdout.trim()
      expect(fs.existsSync(printed)).toBe(true)
      expect(fs.readFileSync(printed, "utf-8")).toContain("<!DOCTYPE html>")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("white_screen 类型标签落盘（非崩溃型白屏报告）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-ws-"))
    try {
      const proc = spawnSync("python3", [SCRIPT, "--type", "white_screen", "--output-dir", dir], {
        input: "# 白屏分析\n\n内容",
        encoding: "utf-8",
      })
      expect(proc.status).toBe(0)
      const printed = proc.stdout.trim()
      expect(printed).toContain("dfx-report-white_screen-")
      expect(fs.readFileSync(printed, "utf-8")).toContain("非崩溃型白屏（WhiteScreen）")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("样式唯一真值源在模板文件：同输入两次生成，样式字节一致（除时间戳）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-style-"))
    try {
      const stripVolatile = (content: string) => content.replace(/生成时间：[0-9: -]+/g, "")
      const first = spawnSync("python3", [SCRIPT, "--type", "app_freeze", "--output-dir", dir], {
        input: SAMPLE_MD,
        encoding: "utf-8",
      })
      const second = spawnSync("python3", [SCRIPT, "--type", "app_freeze", "--output-dir", dir], {
        input: SAMPLE_MD,
        encoding: "utf-8",
      })
      expect(first.status).toBe(0)
      expect(second.status).toBe(0)
      const htmlA = stripVolatile(fs.readFileSync(first.stdout.trim(), "utf-8"))
      const htmlB = stripVolatile(fs.readFileSync(second.stdout.trim(), "utf-8"))
      expect(htmlA).toBe(htmlB)
      // 模板文件是样式的唯一真值源：CSS 在模板内，脚本不内置样式。
      const template = fs.readFileSync(path.join(path.dirname(SCRIPT), "report_template.html"), "utf-8")
      expect(template).toContain("<style>")
      expect(template).toContain(".diff-ins")
      expect(template).toContain(".diff-del")
      expect(template).toContain("{{BODY}}")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("目录导航与代码块滚动：标题锚点、TOC 链接、pre 限高", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-toc-"))
    try {
      const md = [
        "# 冻屏问题综合分析报告",
        "",
        "## 一、分诊结论",
        "",
        "结论内容。",
        "",
        "### 1.1 判定依据",
        "",
        "依据内容。",
        "",
        "## 二、修复建议",
        "",
        "```ts",
        "const a = 1",
        "```",
      ].join("\n")
      const proc = spawnSync("python3", [SCRIPT, "--type", "app_freeze", "--output-dir", dir], {
        input: md,
        encoding: "utf-8",
      })
      expect(proc.status).toBe(0)
      const html = fs.readFileSync(proc.stdout.trim(), "utf-8")
      // 悬浮目录：容器、标题、锚点链接、层级样式（仅收录 h1/h2 章节级，h3 不进目录——
      // 实测回归：appfreeze 修复建议的 `### 简明标题` 曾被误收进导航）
      expect(html).toContain('<nav class="toc" id="dfx-toc">')
      expect(html).toContain('class="toc-title"')
      expect(html).toContain('href="#s-1"')
      expect(html).toContain('id="s-1"')
      expect(html).toContain('class="toc-2"')
      expect(html).not.toContain('class="toc-3"')
      expect(html).not.toContain('href="#s-3"')
      // 吸附式双栏布局（正文 + 右侧目录列，空间预留不重叠）+ 平滑滚动 + 当前节高亮
      expect(html).toContain("position: sticky")
      expect(html).toContain("scroll-behavior: smooth")
      expect(html).toContain("dfx-toc")
      // 代码块超一屏滚动：限高 + 滚动
      expect(html).toContain("max-height: 70vh")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("宽表格横向滚动与转义竖线：滚动容器包裹表格，\\| 不再切断单元格", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-wide-"))
    try {
      const md = [
        "## 采样栈热点函数分析",
        "",
        "| 业务函数 | 出现次数 | 累计耗时(ms) | 说明 |",
        "|---|---|---|---|",
        "| at makeContent (entry\\|@douyin/awe_richtext\\|1.0.0\\|src/main/ets/components/b20/i46.ts:132:18) | 9/10 | 2700 | 富文本内容构建入口 |",
        "| at measureTextSize (foundation/arkui/ace_engine/interfaces/napi/kits/measure/measure.js:27:1) | 9/10 | 2700 | 系统测量 NAPI |",
        "",
        "## 诊断汇总（批量合并报告）",
        "",
        "| 故障日志 | 类型 | 根因位置 |",
        "|---|---|---|",
        "| app_freeze-20261015-175046 | AppFreeze | i46.ts:132:18 |",
      ].join("\n")
      const proc = spawnSync("python3", [SCRIPT, "--type", "app_freeze", "--output-dir", dir], { input: md, encoding: "utf-8" })
      expect(proc.status).toBe(0)
      const html = fs.readFileSync(proc.stdout.trim(), "utf-8")
      // 每张表格都包在横向滚动容器中：宽内容出滚动条，不再溢出遮盖右侧目录
      expect(html).toContain('<div class="table-wrap"><table>')
      expect(html).toContain("</table></div>")
      expect((html.match(/<div class="table-wrap"><table>/g) ?? []).length).toBe(2)
      expect(html).toContain(".table-wrap { overflow-x: auto")
      // 打印态解除滚动裁剪并允许断行，避免打印丢内容
      expect(html).toContain("overflow-wrap: anywhere")
      // 转义竖线是单元格内文本，不参与分列：栈帧完整落在首列，行仍为 4 列
      expect(html).toContain("<td>at makeContent (entry|@douyin/awe_richtext|1.0.0|src/main/ets/components/b20/i46.ts:132:18)</td>")
      const firstRow = html.match(/<tr><td>at makeContent[\s\S]*?<\/tr>/)?.[0] ?? ""
      expect((firstRow.match(/<td>/g) ?? []).length).toBe(4)
      expect(html).not.toContain("<td>at makeContent (entry\\")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("三 Analyzer 模板构造适配：引用块、bash 围栏、typescript 围栏", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-tpl-"))
    try {
      const md = [
        "# CppCrash 问题综合分析报告",
        "",
        "## 故障基本信息",
        "",
        "- **故障时间**：2025-04-20 10:23:45.678",
        "- **崩溃函数**：`libfoo.z.so!Bar(int)+0x24`",
        "",
        "  > 请保留 LastFatalMessage 原始信息，根据其中的信息提示定位崩溃原因。",
        "",
        "## 三级根因定位（依据 CPP_CRASH 故障模式库）",
        "",
        "> 模板判定：本故障未命中 `memory_corruption_second_scene.md`，使用模板 A。",
        "",
        "| 层级 | 根因 | 匹配依据 |",
        "|------|------|----------|",
        "| 一级根因 | CPP_CRASH | name_=CPP_CRASH |",
        "",
        "## 证据链",
        "",
        "```bash",
        "PYTHONIOENCODING=utf-8 python3 script.py --path /tmp/log # 解析日志",
        "```",
        "",
        "```typescript",
        "const name = user.profile?.name ?? \"\"",
        "```",
        "",
        "```diff",
        "- const name = user.profile.name",
        "+ const name = user.profile?.name ?? \"\"",
        "```",
      ].join("\n")
      const proc = spawnSync("python3", [SCRIPT, "--type", "cpp_crash", "--output-dir", dir], {
        input: md,
        encoding: "utf-8",
      })
      expect(proc.status).toBe(0)
      const html = fs.readFileSync(proc.stdout.trim(), "utf-8")
      // 引用块（cppcrash 模板判定/根因编码规则、appfreeze 修复说明均使用）
      expect(html).toContain("<blockquote>")
      expect(html).toContain("请保留 LastFatalMessage")
      expect(html).not.toContain("&gt; 请保留")
      // bash 围栏：# 注释与关键字高亮
      expect(html).toContain('class="tok-com"')
      // typescript 别名高亮
      expect(html).toContain('class="tok-kw"')
      // 表格与 diff 照常
      expect(html).toContain("<table>")
      expect(html).toContain('class="diff-ins"')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("jscrash 层级结构的目录适配：h2 标题 + h3 章节时章节进目录（实测回归）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-toc2-"))
    try {
      const md = [
        "## JS Crash 分析报告",
        "",
        "### 分析结论摘要",
        "",
        "结论。",
        "",
        "### 故障基本信息",
        "",
        "信息。",
        "",
        "### 修复建议（源码不可达，按文字描述修改方向）",
        "",
        "```diff",
        "- old()",
        "+ new()",
        "```",
        "",
        "#### 更深层小节",
        "",
        "内容。",
      ].join("\n")
      const proc = spawnSync("python3", [SCRIPT, "--type", "js_crash", "--output-dir", dir], {
        input: md,
        encoding: "utf-8",
      })
      expect(proc.status).toBe(0)
      const html = fs.readFileSync(proc.stdout.trim(), "utf-8")
      // 相对层级：最浅两级 = h2（标题）+ h3（章节），h3 章节全部进目录
      expect(html).toContain('href="#s-2"')
      expect(html).toContain('href="#s-3"')
      expect(html).toContain('href="#s-4"')
      expect(html).toContain("分析结论摘要")
      expect(html).toContain("故障基本信息")
      // h4 更深层不进目录
      expect(html).not.toContain("层小节</a>")
      expect(html).not.toContain('class="toc-3"')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("批量合并报告的目录适配：四级结构（h1+h2 组+h3 日志+h4 章节）收组与日志条目", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-toc3-"))
    try {
      const md = [
        "# 批量故障分析合并报告",
        "",
        "## 一、分诊摘要",
        "",
        "| # | 文件 | 类型 |",
        "|---|---|---|",
        "| 1 | appfreeze-a.log | AppFreeze |",
        "| 2 | appfreeze-b.log | AppFreeze |",
        "",
        "## 二、AppFreeze 详细分析（2 份）",
        "",
        "### 日志 1：appfreeze-a.log",
        "",
        "分析内容。",
        "",
        "#### 三级根因定位",
        "",
        "根因内容。",
        "",
        "#### 证据链",
        "",
        "证据内容。",
        "",
        "### 日志 2：appfreeze-b.log",
        "",
        "分析内容。",
        "",
        "#### 三级根因定位",
        "",
        "根因内容。",
      ].join("\n")
      const proc = spawnSync("python3", [SCRIPT, "--type", "app_freeze", "--output-dir", dir], {
        input: md,
        encoding: "utf-8",
      })
      expect(proc.status).toBe(0)
      const html = fs.readFileSync(proc.stdout.trim(), "utf-8")
      const nav = html.match(/id="dfx-toc">([\s\S]*?)<\/nav>/)?.[1] ?? ""
      // h2 类型组进目录（toc-1）
      expect(nav).toContain("分诊摘要</a>")
      expect(nav).toContain("AppFreeze 详细分析（2 份）</a>")
      // h3 日志条目进目录（toc-2）——批量报告的核心导航目标
      expect(nav).toContain("日志 1：appfreeze-a.log</a>")
      expect(nav).toContain("日志 2：appfreeze-b.log</a>")
      // h4 章节不进目录
      expect(nav).not.toContain("三级根因定位</a>")
      expect(nav).not.toContain("证据链</a>")
      expect(nav).not.toContain('class="toc-3"')
      // h1 标题不重复占目录位（标题已在报告头部）
      expect(nav).not.toContain("批量故障分析合并报告</a>")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("任务清单防御性渲染：- [ ] / - [x] 转为复选框符号", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-task-"))
    try {
      const md = ["- [ ] 反汇编分析（pc 附近指令）", "- [x] 符号文件 BuildID 核对", "- 普通列表项"].join("\n")
      const proc = spawnSync("python3", [SCRIPT, "--type", "cpp_crash", "--output-dir", dir], {
        input: md,
        encoding: "utf-8",
      })
      expect(proc.status).toBe(0)
      const html = fs.readFileSync(proc.stdout.trim(), "utf-8")
      expect(html).toContain("\u2610 反汇编分析")
      expect(html).toContain("\u2611 符号文件 BuildID 核对")
      expect(html).not.toContain("[ ]")
      expect(html).toContain("<li>普通列表项</li>")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("diff 围栏容忍文件头：--- a/x 与 +++ b/x 渲染为中性文件头而非增删行", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfx-export-diffhdr-"))
    try {
      const md = ["```diff", "--- a/Index.ets", "+++ b/Index.ets", "@@ -10,1 +10,1 @@", "- old line", "+ new line", "```"].join("\n")
      const proc = spawnSync("python3", [SCRIPT, "--type", "js_crash", "--output-dir", dir], {
        input: md,
        encoding: "utf-8",
      })
      expect(proc.status).toBe(0)
      const html = fs.readFileSync(proc.stdout.trim(), "utf-8")
      expect(html).toContain('class="diff-file"')
      expect(html).toContain('class="diff-hunk"')
      expect(html).toContain('class="diff-ins"')
      expect(html).toContain('class="diff-del"')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
