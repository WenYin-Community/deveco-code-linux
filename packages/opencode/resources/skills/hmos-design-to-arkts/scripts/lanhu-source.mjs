import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

export class LanhuError extends Error {
  constructor(input) {
    super(input.message)
    this.name = "LanhuError"
    this.code = input.code
  }
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function parseJson(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return undefined
  }
}

const MAX_FILE = 10 * 1024 * 1024
const MAX_BUNDLE = 64 * 1024 * 1024
export function parseResponse(result, allowIncomplete = false) {
  if (result.content.some((part) => part.type === "text" && Buffer.byteLength(part.text) > MAX_FILE))
    fail("SecurityBlocked", "Lanhu JSON response exceeds the local size limit")
  const values = [
    result.structuredContent,
    ...result.content.flatMap((part) => (part.type === "text" ? [parseJson(part.text)] : [])),
  ]
    .filter(isRecord)
    .filter((value) => typeof value.status === "string")
  const data = values[0]
  if (
    result.isError ||
    !data ||
    (data.status !== "complete" && !(allowIncomplete && ["partial", "failed"].includes(String(data.status))))
  ) {
    throw new LanhuError({
      code: data && typeof data.code === "string" ? data.code : "SourceUnavailable",
      message:
        "Lanhu did not return complete design evidence. Check credentials, source availability and export failures.",
    })
  }
  if (values.some((value) => !isDeepStrictEqual(value, data))) {
    throw new LanhuError({ code: "EvidenceInvalid", message: "Conflicting Lanhu response bodies" })
  }
  return data
}
export function parseReference(url, designId) {
  const parsed = new URL(url)
  if (
    parsed.protocol !== "https:" ||
    !["lanhuapp.com", "www.lanhuapp.com"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  ) {
    throw new LanhuError({ code: "InvalidInput", message: "Use an https://lanhuapp.com UI design link" })
  }
  const query = new URLSearchParams(
    parsed.hash.includes("?") ? parsed.hash.slice(parsed.hash.indexOf("?") + 1) : parsed.search,
  )
  const projectId = query.get("pid") || query.get("project_id")
  const selected = designId || query.get("image_id")
  if (!projectId || !selected || (!designId && parsed.hash.split("?")[0].endsWith("/product"))) {
    throw new LanhuError({ code: "InvalidInput", message: "Select a UI design_id using lanhu_get_designs first" })
  }
  return { projectId, designId: selected, requestedVersion: query.get("versionId") || undefined }
}
export async function resolveRunDir(workspace, runDir) {
  const root = await fs.realpath(workspace)
  const target = path.resolve(root, runDir)
  if (
    !/^\.deveco\/design-to-arkts(?:-fast)?\/runs\/[^/]+$/.test(path.relative(root, target).split(path.sep).join("/"))
  ) {
    throw new LanhuError({
      code: "SecurityBlocked",
      message: "runDir must be a single run inside this workspace's .deveco/design-to-arkts[-fast]/runs",
    })
  }
  await safePath(root, target)
  return target
}
export async function execute(input, workspace, transport) {
  const runDir = await resolveRunDir(workspace, input.runDir)
  const root = path.join(runDir, "source", "lanhu")
  await safePath(runDir, root)
  const identityPath = path.join(root, "target-page-identity.json")
  const previous = await readJson(identityPath)
  if (previous && previous.mcpServerName !== input.server)
    fail("EvidenceInvalid", "This run is bound to another MCP server")
  if (input.operation === "overview") {
    const ref = parseReference(input.url, input.designId)
    if (previous && (previous.designId !== ref.designId || previous.projectId !== ref.projectId))
      fail("EvidenceInvalid", "This run is bound to another design")
    const requestedVersion = input.versionId ?? ref.requestedVersion
    if (
      previous &&
      requestedVersion &&
      requestedVersion !== previous.resolvedVersion &&
      requestedVersion !== previous.requestedVersion
    )
      fail("EvidenceInvalid", "A resumed run cannot change its locked version")
    const data = parseResponse(
      await transport.call("lanhu_get_design_overview", {
        url: input.url,
        design_id: ref.designId,
        version_id: previous?.resolvedVersion ?? input.versionId ?? ref.requestedVersion,
        offset: 0,
        limit: 30,
        annotate: false,
      }),
    )
    const snapshotId = requireID(data.snapshot_id)
    if (
      data.design_id !== ref.designId ||
      !text(data.resolved_version) ||
      !isRecord(data.canvas) ||
      data.coordinate_space !== "source_canvas"
    )
      fail("EvidenceInvalid", "Invalid design identity or source canvas")
    if (previous && (previous.snapshotId !== snapshotId || previous.resolvedVersion !== data.resolved_version))
      fail("EvidenceInvalid", "The locked snapshot changed; use a new run")
    const identity = {
      schemaVersion: 1,
      designSource: "lanhu",
      mcpServerName: input.server,
      projectId: ref.projectId,
      designId: ref.designId,
      requestedVersion: input.versionId ?? ref.requestedVersion ?? "latest",
      resolvedVersion: data.resolved_version,
      snapshotId,
    }
    const evidence = previous ? requireRecord(await readJson(path.join(root, "overview-response.json"))) : data
    if (previous) requireSnapshot(evidence, previous)
    const image = await saveImage(root, "reference.png", data, snapshotId, transport)
    await writeFile(root, "component-recognition.png", await fs.readFile(path.join(root, "reference.png")))
    await writeJson(root, "overview-response.json", evidence)
    await writeJson(root, "target-page-identity.json", previous ?? identity)
    await writeJson(root, "screenshots-manifest.json", {
      schemaVersion: 1,
      snapshotId,
      reference: image,
      componentRecognition: { ...image, path: "source/lanhu/component-recognition.png" },
    })
    await updateContext(root, previous ?? identity, evidence)
    return {
      status: "complete",
      identity: previous ?? identity,
      contextPath: "source/lanhu/design-context.json",
      reference: image,
      nextOffset: data.next_offset,
      total: data.total,
    }
  }
  if (!previous || previous.snapshotId !== requireID(input.snapshotId))
    fail("EvidenceInvalid", "Obtain this run's overview before querying or exporting its snapshot")
  if (input.operation === "inspect") {
    const overview = requireRecord(await readJson(path.join(root, "overview-response.json")))
    const offset = input.offset ?? 0
    const limit = input.limit ?? 30
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 60)
      fail("InvalidInput", "Use a nonnegative offset and a limit from 1 to 60")
    const region = input.region ?? overview.canvas
    if (
      !isRecord(region) ||
      ![region.x ?? 0, region.y ?? 0, region.width, region.height].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ) ||
      Number(region.width) <= 0 ||
      Number(region.height) <= 0
    )
      fail("InvalidInput", "Invalid source-canvas region")
    const args = {
      snapshot_id: input.snapshotId,
      region: { x: region.x ?? 0, y: region.y ?? 0, width: region.width, height: region.height },
      ...(input.nodeIds ? { node_ids: input.nodeIds } : {}),
      offset,
      limit,
      annotate: true,
    }
    const queryId = sha256(Buffer.from(JSON.stringify(args))).slice(0, 32)
    const data = parseResponse(await transport.call("lanhu_inspect_design_region", args))
    requireSnapshot(data, previous)
    if (
      data.coordinate_space !== "source_canvas" ||
      !isRecord(data.coordinate_mapping) ||
      data.coordinate_mapping.verified !== true ||
      !isDeepStrictEqual(data.canvas, overview.canvas)
    )
      fail("EvidenceInvalid", "Region coordinate mapping differs from the locked canvas")
    if (
      !Array.isArray(data.nodes) ||
      data.returned !== data.nodes.length ||
      !Number.isInteger(data.total) ||
      Number(data.total) < data.nodes.length ||
      typeof data.truncated !== "boolean"
    )
      fail("EvidenceInvalid", "Invalid node pagination")
    if (
      data.truncated
        ? !Number.isInteger(data.next_offset) || Number(data.next_offset) <= offset
        : data.next_offset !== null
    )
      fail("EvidenceInvalid", "Invalid next_offset")
    const image = await saveImage(root, `regions/${queryId}/clean.png`, data, input.snapshotId, transport)
    await writeJson(root, `regions/${queryId}/response.json`, data)
    const index = (await readJson(path.join(root, "region-index.json"))) ?? { queries: [] }
    const queries = Array.isArray(index.queries) ? index.queries.filter(isRecord) : []
    const entry = {
      queryId,
      offset,
      limit,
      fullCanvas: !input.region && !input.nodeIds,
      responsePath: `source/lanhu/regions/${queryId}/response.json`,
      responseSha256: sha256(
        Buffer.from(
          JSON.stringify(data, null, 2) +
            `
`,
        ),
      ),
      image,
      total: data.total,
      returned: data.returned,
      nextOffset: data.next_offset,
      truncated: data.truncated,
    }
    await writeJson(root, "region-index.json", {
      schemaVersion: 1,
      snapshotId: input.snapshotId,
      queries: [...queries.filter((item) => item.queryId !== queryId), entry],
    })
    await updateContext(root, previous, overview)
    return { status: "complete", ...entry, nodeIds: data.nodes.filter(isRecord).map((node) => node.node_id) }
  }
  if (input.operation === "export") {
    if (
      !input.assetIds.length ||
      new Set(input.assetIds).size !== input.assetIds.length ||
      input.assetIds.some((id) => !text(id))
    )
      fail(
        "InvalidInput",
        "Select distinct non-empty asset IDs; record an empty asset plan without exporting when no assets are needed",
      )
    const data = parseResponse(
      await transport.call("lanhu_export_design_assets", {
        snapshot_id: input.snapshotId,
        asset_ids: input.assetIds,
        format_preference: input.formatPreference ?? "original",
      }),
      true,
    )
    requireSnapshot(data, previous)
    const bundleId = requireID(data.bundle_id)
    if (data.status !== "complete") {
      await writeJson(root, `exports/${bundleId}/export-response.json`, data)
      fail("MissingAsset", "Lanhu export was incomplete; inspect the saved export-response.json failed list")
    }
    if (
      !Array.isArray(data.failed) ||
      data.failed.length ||
      !Array.isArray(data.assets) ||
      data.assets.length !== input.assetIds.length
    )
      fail("MissingAsset", "Export must contain every selected resource and no failures")
    const exported = data.assets.filter(isRecord)
    if (
      new Set(exported.map((asset) => String(asset.base_asset_id ?? asset.asset_id))).size !== input.assetIds.length ||
      exported.some((asset) => !input.assetIds.includes(String(asset.base_asset_id ?? asset.asset_id)))
    )
      fail("EvidenceInvalid", "Export includes unexpected assets")
    if (
      exported.some(
        (asset) =>
          !Number.isInteger(asset.bytes) ||
          Number(asset.bytes) <= 0 ||
          Number(asset.bytes) > MAX_FILE ||
          !text(asset.sha256) ||
          !/^[a-f0-9]{64}$/.test(asset.sha256),
      )
    )
      fail("MissingAsset", "Exported resources exceed local limits or lack verified hashes")
    if (typeof data.bundle_bytes !== "number" || data.bundle_bytes > MAX_BUNDLE || data.bundle_bytes <= 0)
      fail("SecurityBlocked", "Resource bundle exceeds local limits")
    const bundle = await binary(
      transport,
      data.bundle_resource,
      input.snapshotId,
      "bundle",
      MAX_BUNDLE,
      "application/zip",
    )
    if (data.bundle_bytes !== bundle.length)
      fail("EvidenceInvalid", "Resource bundle size differs from the export response")
    await writeFile(root, `exports/${bundleId}/bundle.zip`, bundle)
    await writeJson(root, `exports/${bundleId}/export-response.json`, data)
    await writeJson(root, `exports/${bundleId}/delivery.json`, {
      snapshotId: input.snapshotId,
      bundleId,
      sha256: sha256(bundle),
      size: bundle.length,
      selectedAssetIds: input.assetIds,
    })
    return {
      status: "complete",
      snapshotId: input.snapshotId,
      bundleId,
      path: `source/lanhu/exports/${bundleId}/bundle.zip`,
      sha256: sha256(bundle),
    }
  }
  const bundleId = requireID(input.bundleId)
  const exported = requireRecord(await readJson(path.join(root, `exports/${bundleId}/export-response.json`)))
  const delivery = requireRecord(await readJson(path.join(root, `exports/${bundleId}/delivery.json`)))
  requireSnapshot(exported, previous)
  if (exported.status !== "complete") fail("MissingAsset", "Only a complete export can be installed")
  const bundle = await safePath(root, path.join(root, `exports/${bundleId}/bundle.zip`))
  const bytes = await fs.readFile(bundle)
  if (bytes.length > MAX_BUNDLE || bytes.length !== delivery.size || sha256(bytes) !== delivery.sha256)
    fail("EvidenceInvalid", "The exported ZIP changed before installation")
  if (!path.isAbsolute(input.python))
    fail(
      "InvalidInput",
      "python must be the absolute path to the interpreter with the pinned lanhu_design package installed",
    )
  const destination = await safePath(root, path.join(root, `delivery/${bundleId}`))
  await transport.install(input.python, bundle, destination)
  const receipt = requireRecord(await readJson(path.join(destination, "install-receipt.json")))
  requireSnapshot(receipt, previous)
  if (
    receipt.status !== "complete" ||
    receipt.bundle_id !== bundleId ||
    !Array.isArray(receipt.assets) ||
    !Array.isArray(exported.assets) ||
    receipt.assets.length !== exported.assets.length
  )
    fail("EvidenceInvalid", "Installation receipt does not match the exported bundle")
  const exportedAssets = exported.assets.filter(isRecord)
  const assets = await Promise.all(
    receipt.assets.map(async (item) => {
      const asset = requireRecord(item)
      const expected = exportedAssets.find((entry) => entry.asset_id === asset.asset_id)
      if (
        !expected ||
        expected.sha256 !== asset.sha256 ||
        expected.relative_path !== asset.relative_path ||
        expected.node_id !== asset.node_id ||
        expected.bytes !== asset.bytes
      )
        fail("EvidenceInvalid", "Installation receipt changed an exported asset")
      if (
        !text(asset.relative_path) ||
        !asset.relative_path.startsWith("assets/") ||
        !text(asset.sha256) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256)
      )
        fail("EvidenceInvalid", "Invalid asset path or hash")
      const file = await safePath(destination, path.resolve(destination, asset.relative_path))
      if (
        asset.local_path !== file ||
        !Number.isInteger(asset.bytes) ||
        Number(asset.bytes) <= 0 ||
        Number(asset.bytes) > MAX_FILE ||
        (await fs.stat(file)).size !== asset.bytes ||
        sha256(await fs.readFile(file)) !== asset.sha256
      )
        fail("EvidenceInvalid", "Installed asset bytes or path do not match the receipt")
      return {
        assetId: asset.asset_id,
        nodeId: asset.node_id,
        path: path.relative(runDir, file).split(path.sep).join("/"),
        sha256: asset.sha256,
        size: asset.bytes,
      }
    }),
  )
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length)
    fail("EvidenceInvalid", "Duplicate installed asset IDs")
  await writeJson(root, `delivery/${bundleId}/verified.json`, {
    schemaVersion: 1,
    producer: { script: "lanhu-capture.mjs" },
    snapshotId: input.snapshotId,
    bundleId,
    assets,
    receiptSha256: sha256(await fs.readFile(path.join(destination, "install-receipt.json"))),
  })
  return {
    status: "complete",
    snapshotId: input.snapshotId,
    bundleId,
    receiptPath: `source/lanhu/delivery/${bundleId}/install-receipt.json`,
    assets,
  }
}
async function updateContext(root, identity, overview) {
  const index = await readJson(path.join(root, "region-index.json"))
  const pages = (Array.isArray(index?.queries) ? index.queries.filter(isRecord) : [])
    .filter((query) => query.fullCanvas === true)
    .toSorted((a, b) => Number(a.offset) - Number(b.offset))
  const nodes = new Map()
  const next = { offset: 0, complete: false, total: undefined }
  for (const page of pages) {
    if (page.offset !== next.offset || next.complete) continue
    const file = await safePath(root, path.resolve(root, "..", "..", String(page.responsePath)))
    const bytes = await fs.readFile(file)
    if (sha256(bytes) !== page.responseSha256) fail("EvidenceInvalid", "Saved node evidence changed")
    const response = requireRecord(await readJson(file))
    requireSnapshot(response, identity)
    if (next.total !== undefined && next.total !== response.total)
      fail("EvidenceInvalid", "Node count changed within the snapshot")
    for (const node of Array.isArray(response.nodes) ? response.nodes : []) {
      if (!isRecord(node) || !text(node.node_id) || nodes.has(node.node_id))
        fail("EvidenceInvalid", "Missing or duplicated node IDs across pages")
      nodes.set(node.node_id, node)
    }
    next.total = Number(response.total)
    next.offset = Number(response.next_offset)
    next.complete = response.truncated === false && nodes.size === next.total
  }
  await writeJson(root, "node-index.json", {
    schemaVersion: 1,
    snapshotId: identity.snapshotId,
    complete: next.complete,
    total: next.total ?? null,
    nodes: [...nodes.values()],
  })
  await writeJson(root, "design-context.json", {
    schemaVersion: 1,
    producer: { script: "lanhu-capture.mjs", implementation: "dsphper/lanhu-mcp" },
    identity,
    canvas: overview.canvas,
    coordinateSpace: overview.coordinate_space,
    coordinateMapping: overview.coordinate_mapping,
    capabilities: overview.capabilities,
    gaps: overview.gaps,
    scaleMetadata: overview.scale_metadata,
    nodeIndex: {
      path: "source/lanhu/node-index.json",
      complete: next.complete,
      count: nodes.size,
      total: next.total ?? null,
    },
    regionIndex: "source/lanhu/region-index.json",
    screenshots: "source/lanhu/screenshots-manifest.json",
  })
}
async function saveImage(root, name, data, snapshotId, transport) {
  const uri = data.reference_crop_resource ?? data.preview_resource
  const bytes = await binary(transport, uri, snapshotId, "preview", MAX_FILE, "image/png")
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    fail("EvidenceInvalid", "Reference is not a PNG image")
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (
    !width ||
    !height ||
    width * height > 80000000 ||
    !isRecord(data.image_size) ||
    data.image_size.width !== width ||
    data.image_size.height !== height
  )
    fail("EvidenceInvalid", "PNG dimensions differ from source evidence")
  await transport.decodeImage(bytes)
  await writeFile(root, name, bytes)
  return {
    path: `source/lanhu/${name}`,
    width,
    height,
    size: bytes.length,
    sha256: sha256(bytes),
    resourceUri: uri,
    sourceRegion: data.source_region,
    scale: data.scale,
    visualSource: data.visual_source,
  }
}
async function binary(transport, uri, snapshotId, kind, max, mime) {
  if (typeof uri !== "string" || !new RegExp(`^lanhu://design/${snapshotId}/${kind}/[a-f0-9]{32}$`).test(uri))
    fail("EvidenceInvalid", "Resource URI does not belong to this snapshot")
  const response = await transport.read(uri)
  const item = response.contents[0]
  if (
    response.contents.length !== 1 ||
    !item ||
    !("blob" in item) ||
    item.uri !== uri ||
    (item.mimeType !== mime && item.mimeType !== "application/octet-stream") ||
    typeof item.blob !== "string" ||
    item.blob.length > Math.ceil(max / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.blob)
  )
    fail("EvidenceInvalid", "Expected one bounded binary MCP resource with matching URI and MIME")
  const bytes = Buffer.from(item.blob, "base64")
  if (!bytes.length || bytes.length > max) fail("SecurityBlocked", "Resource exceeds the local size limit")
  if (mime === "application/zip" && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])))
    fail("EvidenceInvalid", "Resource bundle is not a ZIP archive")
  return bytes
}
async function safePath(root, target) {
  const rel = path.relative(root, target)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    fail("SecurityBlocked", "Path escapes its evidence directory")
  const parts = path.resolve(target).split(path.sep)
  for (const index of parts.keys()) {
    const current = parts.slice(0, index + 1).join(path.sep) || path.parse(target).root
    const info = await fs.lstat(current).catch((error) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (info?.isSymbolicLink()) fail("SecurityBlocked", "Evidence paths must not contain symbolic links")
  }
  return target
}
async function readJson(file) {
  await safePath(path.dirname(file), file)
  const info = await fs.stat(file).catch((error) => {
    if (error.code === "ENOENT") return
    throw error
  })
  if (!info) return
  if (!info.isFile() || info.size > MAX_FILE) fail("EvidenceInvalid", "Invalid JSON evidence file")
  const value = parseJson(await fs.readFile(file, "utf8"))
  if (!isRecord(value)) fail("EvidenceInvalid", "Invalid JSON evidence")
  return value
}
async function writeFile(root, rel, data) {
  const target = await safePath(root, path.resolve(root, rel))
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 })
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}
async function writeJson(root, rel, data) {
  const bytes = Buffer.from(
    JSON.stringify(data, null, 2) +
      `
`,
  )
  if (bytes.length > MAX_FILE) fail("SecurityBlocked", "Design evidence exceeds the local file size limit")
  await writeFile(root, rel, bytes)
}
function requireSnapshot(data, identity) {
  if (data.snapshot_id !== identity.snapshotId || data.resolved_version !== identity.resolvedVersion)
    fail("EvidenceInvalid", "Response belongs to another snapshot or version")
}
function requireRecord(value) {
  if (!isRecord(value)) fail("EvidenceInvalid", "Required design evidence is missing")
  return value
}
function requireID(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value))
    fail("InvalidInput", "Expected a 32-character Lanhu snapshot or bundle ID")
  return value
}
function text(value) {
  return typeof value === "string" && value.trim().length > 0
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
function fail(code, message) {
  throw new LanhuError({ code, message })
}
