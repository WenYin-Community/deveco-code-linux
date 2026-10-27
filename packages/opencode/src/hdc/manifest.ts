export * as HdcManifest from "./manifest"

// ─── HDC Guard product manifest (SR1 v3.0) ──────────────────
// Single source of truth for the preset device-side boundaries
// SR1 enforces without user configuration (§2.2 rule 1). SR1
// offers no user rules; SR2 will build its policy surface on top
// of these defaults.

// Device-allowed paths for real-device file transfer (§0.2
// "设备允许路径"): the only device-side directory tree `file
// send`/`file recv` may touch. Transition value for TBD-01 —
// frozen per-product, never per-project.
export const DEVICE_ALLOWED_PATHS = ["/data/local/tmp/"]
