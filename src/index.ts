import { exec } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'
/**
 * 使用 `npm view` 获取一个 npm 包可下载链接，下载后解压读取 `package.json` 以获取 main 字段，
 * 读取主文件的内容，然后清理临时文件。
 *
 * @param options - 获取包的选项。
 * @param options.name - 要获取的 npm 包的名称。
 * @param options.retry - 可选。重试次数，默认为 1。
 * @param options.dist - 可选。要在包导出中查找的分发目录。
 * @returns 获取包的主文件的内容。
 * @throws 如果包无法获取、解压或读取，将抛出错误。
 */
export async function fetchAndExtractPackage(options: { name: string, dist?: string, retry?: number }) {
  const { name, dist, retry = 1 } = options
  const tempFile = name.split('/').join('-')
  const url = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url)
  const tempDir = path.join(url, '..', tempFile)
  try {
    await requestAuth(path.join(url, '..'))

    // Create temporary directory

    await fs.mkdir(tempDir, { recursive: true })

    // Get the package tarball URL
    const tgzPath = await Promise.any([
      downloadWithHttp(name, tempDir, tempFile, retry),
      downloadWitchPack(name, tempDir, retry),
    ])

    // eslint-disable-next-line no-console
    console.log('download tgz success!')
    // Extract the tarball
    await tar.x({ file: tgzPath, cwd: tempDir })

    // eslint-disable-next-line no-console
    console.log('extract success!')

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

async function retryAsync<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  try {
    return await fn()
  }
  catch (error: any) {
    if (retries > 0) {
      return retryAsync(fn, retries - 1)
    }
    else {
      throw error
    }
  }
}

async function downloadWitchPack(name: string, tempDir: string, retry: number) {
  await retryAsync(() => {
    return new Promise((resolve, reject) => {
      exec(`npm pack ${name} --pack-destination ${tempDir}`, (error) => {
        if (error) {
          console.error(error)
          reject(error)
        }
        else {
          resolve(true)
        }
      })
    })
  }, retry)
  const tarballPattern = `${name.replace('@', '').replace('/', '-')}-.*.tgz`
  const [tarballPath] = await fs.readdir(tempDir).then(files => files.filter(file => file.match(tarballPattern)))
  return path.join(tempDir, tarballPath)
}

async function downloadWithHttp(name: string, tempDir: string, tempFile: string, retry: number) {
  const tarballUrl = await retryAsync(async () => {
    return new Promise((resolve, reject) => {
      exec(`npm view ${name} dist.tarball`, (error, stdout) => {
        if (error) {
          reject(error)
        }
        else {
          resolve(stdout.trim())
        }
      })
    })
  }, retry)

  if (!tarballUrl)
    return ''
  const protocol = new URL(tarballUrl).protocol
  const lib = protocol === 'https:' ? https : http
  const tgzPath = path.join(tempDir, `${tempFile}.tgz`)
  const tgzFile = createWriteStream(tgzPath)

  await retryAsync(() => new Promise<void>((resolve, reject) => {
    lib.get(tarballUrl, (response) => {
      response.pipe(tgzFile)
      tgzFile.on('finish', () => {
        tgzFile.close()
        resolve()
      })
    }).on('error', (error) => {
      fs.unlink(tgzPath).catch((error) => {
        reject(error)
      })
      reject(error)
    })
  }), retry)

  return tgzPath
}

function requestAuth(tempDir: string) {
  return fs.chmod(tempDir, 0o777)
}
