import { $ } from "bun"
import { mkdir, open, unlink } from "node:fs/promises"
import path from "node:path"

export const licenseFiles = ["LICENSE", "LICENSING.md", "NOTICE", "LICENSES/MIT.txt"]

export async function copyLicenses(directory: string) {
  await Promise.all(
    licenseFiles.map(async (file) => {
      await Bun.write(path.join(directory, file), Bun.file(new URL(`../../../${file}`, import.meta.url)))
    }),
  )
}

export async function packWithLicenses(directory: string) {
  const created: string[] = []
  try {
    for (const file of licenseFiles) {
      const target = path.join(directory, file)
      await mkdir(path.dirname(target), { recursive: true })
      // Never overwrite a package-local notice or clean up a file we didn't create.
      const handle = await open(target, "wx")
      created.push(target)
      try {
        await handle.writeFile(await Bun.file(new URL(`../../../${file}`, import.meta.url)).bytes())
      } finally {
        await handle.close()
      }
    }
    await $`bun pm pack`.cwd(directory)
  } finally {
    await Promise.all(created.map((file) => unlink(file)))
  }
}
