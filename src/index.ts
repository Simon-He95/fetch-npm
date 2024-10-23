import { exec } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'

/**
 * 使用 `npm pack` 获取一个 npm 包，解压它，读取 `package.json` 以获取 main 字段，
 * 读取主文件的内容，然后清理临时文件。
 *
 * @param options - 获取包的选项。
 * @param options.name - 要获取的 npm 包的名称。
 * @param options.dist - 可选。要在包导出中查找的分发目录。
 * @returns 获取包的主文件的内容。
 * @throws 如果包无法获取、解压或读取，将抛出错误。
 */
export async function fetchWithPack(options: { name: string, dist?: string }) {
  const { name, dist } = options
  const url = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url)
  const tempDir = path.join(url, '..', 'temp')
  const tarballPattern = `${name.replace('@', '').replace('/', '-')}-.*.tgz`
  try {
    // Create temporary directory
    await fs.mkdir(tempDir, { recursive: true })

    // Fetch the package tarball using npm pack
    await new Promise((resolve, reject) => {
      exec(`npm pack ${name} --pack-destination ${tempDir}`, (error) => {
        if (error)
          reject(error)
        else
          resolve(true)
      })
    })

    const [tarballPath] = await fs.readdir(tempDir).then(files => files.filter(file => file.match(tarballPattern)))
    // Extract the tarball
    await tar.x({ file: path.join(tempDir, tarballPath), cwd: tempDir })

    // Read package.json to get the main field
    const packageJsonPath = path.join(tempDir, 'package', 'package.json')
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))

    let mainFile = packageJson.main || 'index.js'
    if (dist && !mainFile.includes(dist) && packageJson.exports) {
      for (const key in packageJson.exports) {
        const { import: importUri, require: requireUri } = packageJson.exports[key] || {}
        if (importUri?.includes(dist)) {
          mainFile = importUri
          break
        }
        else if (requireUri?.includes(dist)) {
          mainFile = requireUri
          break
        }
      }
    }
    // Read the main file content
    const mainFilePath = path.join(tempDir, 'package', mainFile)
    const mainFileContent = await fs.readFile(mainFilePath, 'utf-8')

    // Clean up: remove the temporary directory and tarball
    await fs.rm(tempDir, { recursive: true, force: true })

    return mainFileContent
  }
  catch (error) {
    // Clean up in case of error
    await fs.rm(tempDir, { recursive: true, force: true })
    throw error
  }
}
