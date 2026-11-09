import type { HdcOperation } from "./operation"
import { categoryOf } from "./operation"
import { getProductPolicy } from "./product-policy"
import type { PermissionEffect, PolicySource, ApprovalResult } from "./decision"

// ─── Known operation policy (AR-SEC2-004) ──────────────────
// Evaluates known operations against product default and object boundaries.
// Does NOT modify original argv.
// Output includes: productDefault, productCeiling, risk, approval facts.

// ─── Policy evaluation result ──────────────────────────────
export interface PolicyEvaluation {
  effect: PermissionEffect
  productDefault: PermissionEffect
  productCeiling: PermissionEffect
  policySource: PolicySource
  approvalResult: ApprovalResult
  risk: string
  approvalFacts: ApprovalFacts
}

export interface ApprovalFacts {
  operationType: string
  targetAppOrPath: string
  targetDevice: string
  reason: string
}

// ─── Evaluate known operation ──────────────────────────────
// This runs after hard deny check and object validation.
// It produces the product default decision and ceiling for the operation.

export function evaluateKnownPolicy(operation: HdcOperation): PolicyEvaluation {
  const policy = getProductPolicy(operation)
  const category = categoryOf(operation)

  return {
    effect: policy.productDefault,
    productDefault: policy.productDefault,
    productCeiling: policy.productCeiling,
    policySource: "product_default",
    approvalResult: "not_required",
    risk: getRiskDescription(category),
    approvalFacts: getApprovalFacts(operation),
  }
}

// ─── Fallback policy (AR-SEC2-005) ─────────────────────────
// Only reached after hard deny and known policy evaluation.
// Unclassified but carriable operations get one-time ask.

export function evaluateFallbackPolicy(operation: HdcOperation): PolicyEvaluation {
  // Only unclassified operations reach here
  if (operation.kind !== "unclassified") {
    // This should not happen — known operations are handled earlier
    return evaluateKnownPolicy(operation)
  }

  return {
    effect: "ask",
    productDefault: "ask",
    productCeiling: "ask",
    policySource: "product_default",
    approvalResult: "not_required",
    risk: "产品尚未识别该操作，影响未知",
    approvalFacts: {
      operationType: "unclassified",
      targetAppOrPath: "unknown",
      targetDevice: "unknown",
      reason: "操作未命中产品已定义策略，需用户逐次确认",
    },
  }
}

// ─── Risk descriptions per category ────────────────────────

function getRiskDescription(category: string): string {
  switch (category) {
    case "non_device_query":
      return "只读查询，不修改设备状态"
    case "device_readonly":
      return "设备只读操作，不修改设备状态"
    case "install_start":
      return "安装或启动应用，会修改设备应用状态"
    case "file_transfer":
      return "文件传输，会修改设备或本机文件"
    case "app_lifecycle":
      return "应用生命周期操作，会修改设备应用状态"
    case "device_file_change":
      return "设备文件变更，会修改设备文件系统"
    case "param_change":
      return "参数修改，会修改设备系统参数"
    case "diagnostic":
      return "诊断输出，包含设备状态信息"
    case "connection_forward":
      return "连接或端口转发，会修改设备网络配置"
    case "system_state":
      return "系统状态操作，会修改设备运行状态"
    case "firmware_mutation":
      return "固件变更，会修改设备固件"
    default:
      return "影响未知"
  }
}

// ─── Approval facts per operation ──────────────────────────

const CONTEXT_DEVICE = "from context"

function getApprovalFacts(operation: HdcOperation): ApprovalFacts {
  return factsForKnownOperation(operation) ?? facts("unclassified", "unknown", "unknown", "操作未命中产品已定义策略")
}

// Returns undefined for unclassified so the caller owns the fallback.
function factsForKnownOperation(operation: HdcOperation): ApprovalFacts | undefined {
  switch (operation.kind) {
    case "versionOrHelp":
      return facts("version/help", "N/A", "N/A", "非设备查询")
    case "listTargets":
      return facts("list targets", "N/A", "N/A", "设备发现")
    case "discover":
      return facts("discover", "N/A", "N/A", "设备发现")
    case "install":
      return facts("install", operation.packagePath, CONTEXT_DEVICE, "安装应用包到设备")
    case "fileSend":
      return facts("file send", `${operation.localPath} → ${operation.remotePath}`, CONTEXT_DEVICE, "发送文件到设备")
    case "fileRecv":
      return facts("file recv", `${operation.remotePath} → ${operation.localPath}`, CONTEXT_DEVICE, "从设备接收文件")
    case "uninstall":
      return facts("uninstall", operation.bundleName, CONTEXT_DEVICE, "卸载设备应用")
    case "appControl":
      return facts(operation.action, operation.bundleName ?? "unknown", CONTEXT_DEVICE, "应用生命周期控制")
    case "shell":
      return facts(`shell ${operation.deviceArgv.join(" ")}`, "N/A", CONTEXT_DEVICE, "执行设备侧命令")
    case "hilog":
      return facts("hilog", "N/A", CONTEXT_DEVICE, "设备日志输出")
    case "bugreport":
      return facts("bugreport", operation.localPath ?? "default", CONTEXT_DEVICE, "诊断报告输出")
    case "transportConnect":
      return facts("tconn", operation.endpoint, "N/A", "设备连接")
    case "portForward":
      return facts(`${operation.direction} port forward`, operation.args.join(" "), CONTEXT_DEVICE, "端口转发")
    case "modeOrDaemon":
      return facts(operation.action, "N/A", CONTEXT_DEVICE, "系统模式/守护进程操作")
    case "rebootOrBoot":
      return facts("reboot/boot", "N/A", CONTEXT_DEVICE, "设备重启")
    case "firmwareMutation":
      return facts(operation.command, "N/A", CONTEXT_DEVICE, "固件变更（硬拒绝）")
    case "unclassified":
      return undefined
    default:
      return undefined
  }
}

function facts(operationType: string, targetAppOrPath: string, targetDevice: string, reason: string): ApprovalFacts {
  return { operationType, targetAppOrPath, targetDevice, reason }
}
