import path from "path"
import { randomUUID } from "crypto"
import { rename } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { AGREEMENT_DEFAULTS } from "./deveco-legal"
import { regionPolicy, MAINLAND_CHINA_ONLY_MESSAGE } from "@/plugin/deveco/region-policy"

declare const DEVECO_SKIP_AGREEMENT: boolean | undefined

export class ProductAgreementVersionError extends Error {}

export const PRODUCT_AGREEMENT_VERSION = "1"

export const AGREEMENT_REVIEW_REQUIRED_MESSAGE =
  "The DevEco Code service agreements changed. Review and accept them before retrying your request."

export async function productAgreement() {
  const stored: unknown = await Bun.file(path.join(Global.Path.state, "product-agreement.json"))
    .json()
    .catch(() => null)
  return {
    version: PRODUCT_AGREEMENT_VERSION,
    termsUrl: AGREEMENT_DEFAULTS.terms_url,
    privacyUrl: AGREEMENT_DEFAULTS.privacy_url,
    acceptedAt:
      typeof stored === "object" && stored !== null && "acceptedAt" in stored && typeof stored.acceptedAt === "number"
        ? stored.acceptedAt
        : undefined,
    accepted:
      typeof stored === "object" &&
      stored !== null &&
      "version" in stored &&
      stored.version === PRODUCT_AGREEMENT_VERSION,
  }
}

export async function acceptProductAgreement(version: string, serviceRevision?: string) {
  if (version !== PRODUCT_AGREEMENT_VERSION)
    throw new ProductAgreementVersionError("The product agreements changed. Review them again before accepting.")
  const { acceptServiceRevision, uploadAgreement } = await import("./deveco-agreement-sync")
  if (serviceRevision) await acceptServiceRevision(serviceRevision)
  const file = path.join(Global.Path.state, "product-agreement.json")
  const temporary = `${file}.${randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify({ version, acceptedAt: Date.now() }), { mode: 0o600 })
  await rename(temporary, file)
  await uploadAgreement()
  return productAgreement()
}

export async function requireProductAccess() {
  const region = await regionPolicy.checkAccess()
  if (!region.allowed) throw new Error(MAINLAND_CHINA_ONLY_MESSAGE)
  // Only the compile-time define (`script/build.ts --skip-agreement`, for
  // source/internal builds) may bypass acceptance. Released binaries bake
  // `false`, and no runtime env channel exists: the product agreements are
  // mandatory for every feature of a distributed build.
  if (typeof DEVECO_SKIP_AGREEMENT !== "undefined" && DEVECO_SKIP_AGREEMENT) return
  if (!(await productAgreement()).accepted) {
    throw new Error(
      "Review the product agreements in DevEco Code or run `deveco auth consent` on the server before continuing.",
    )
  }
  const { waitForAgreementSync, agreementUploadStatus } = await import("./deveco-agreement-sync")
  await waitForAgreementSync()
  if ((await agreementUploadStatus()).state === "review_required") {
    throw new Error(AGREEMENT_REVIEW_REQUIRED_MESSAGE)
  }
}

export async function productAgreementDetails() {
  const { waitForAgreementSync, agreementUploadStatus } = await import("./deveco-agreement-sync")
  await waitForAgreementSync()
  return { ...(await productAgreement()), upload: await agreementUploadStatus() }
}
