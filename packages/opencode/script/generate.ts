import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const localSnapshot = path.resolve(__dirname, "../resources/models.dev.json")
const modelsUrl = process.env.DEVECO_MODELS_URL || "https://models.dev"
const disableModelsFetch = ["true", "1"].includes(
  (process.env.DEVECO_DISABLE_MODELS_FETCH ?? "").toLowerCase(),
)

export const modelsData = disableModelsFetch
  ? "{}"
  : process.env.MODELS_DEV_API_JSON
    ? await Bun.file(process.env.MODELS_DEV_API_JSON).text()
      : (await Bun.file(localSnapshot).exists())
        ? await Bun.file(localSnapshot).text()
        : await fetch(`${modelsUrl}/api.json`).then((x) => x.text())

if (disableModelsFetch) console.warn("Warning: DEVECO_DISABLE_MODELS_FETCH set, build uses empty models snapshot")
else if (await Bun.file(localSnapshot).exists()) console.log(`Loaded models.dev snapshot from ${localSnapshot}`)
else console.log("Loaded models.dev snapshot from remote")
