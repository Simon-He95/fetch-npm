import { createWriteStream, existsSync, promises as fsp } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { retryAsync } from 'lazy-js-utils'
import { jsShell } from 'lazy-js-utils/node'
import * as tar from 'tar'
import {
  createNpmEnv,
  createTempCachePath,
  fetchRegistryMetadata,
  getCacheFilePath,
  mergeHeaders,
  normalizeRegistries,
  persistCacheFile,
  resolveExportTarget,
  resolveTarballFromMetadata,
} from './utils'

const DEFAULT_DOWNLOAD_TIMEOUT = Number.parseInt(process.env.FETCH_NPM_TIMEOUT || '15000', 10) || 15000

interface FetchPackageOptions {
  name: string
  dist?: string
  retry?: number
  logger?: {
    info: (msg: string) => void
    error: (msg: string) => void
  }
  registry?: string | string[]
  authToken?: string
  headers?: Record<string, string>
  cacheDir?: string
}

interface DownloadHttpOptions {
  registries?: string[]
  headers?: Record<string, string>
  cacheDir?: string
}

interface NpmCliOptions {
  registry?: string
  authToken?: string
  cacheDir?: string
}

interface DownloadTask {
  promise: Promise<string>
  cancel?: () => void
}
/**
 * 使用 `npm view` 获取一个 npm 包可下载链接,下载后解压读取 `package.json` 以获取 main 字段,
 * 读取主文件的内容,然后清理临时文件.
 *
 * @param options - 获取包的选项.
 * @param options.name - 要获取的 npm 包的名称.
 * @param options.retry - 可选.重试次数,默认为 1.
 * @param options.dist - 可选.要在包导出中查找的分发目录.
 * @param options.logger - 可选.在 vscode 插件中输出日志.
 * @returns 获取包的主文件的内容.
 * @throws 如果包无法获取、解压或读取,将抛出错误.
 */
export async function fetchAndExtractPackage(options: FetchPackageOptions) {
  const loggerPrefix = '[fetch-npm]:'
  const {
    name,
    dist,
    retry = 1,
    logger = {
      info: (msg: string) => {
        // eslint-disable-next-line no-console
        console.log(msg)
      },
      error: (err: string) => {
        console.error(err)
      },
    },
    registry,
    authToken,
    headers,
    cacheDir: cacheDirOption,
  } = options
  const tempFile = name.split('/').join('-')
  const url = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url)
  const distPackageJsonPath = path.join(url, '..', 'package.json')
  let tempDir = ''
  const registries = normalizeRegistries(registry)
  const requestHeaders = mergeHeaders(headers, authToken)
  const cacheDir = cacheDirOption ? path.resolve(cacheDirOption) : undefined

  try {
    // 为了兼容低版本 npm,需要 package.json
    // 判断当前位置是否有 package.json, 如果无从新建一份
    if (!existsSync(distPackageJsonPath)) {
      await fsp.writeFile(distPackageJsonPath, JSON.stringify({
        name: 'temp',
        version: '1.0.0',
      }), 'utf-8')
    }
    // Create temporary directory in os tmpdir
    tempDir = await fsp.mkdtemp(path.join(tmpdir(), `fetch-npm-${tempFile}-`))

    // Get the package tarball URL
    const tgzPath = await retryAsync(async () => {
      const tasks: DownloadTask[] = [
        downloadWithHttp(name, path.join(tempDir, 'http'), tempFile, logger, {
          registries,
          headers: requestHeaders,
          cacheDir,
        }),
        downloadWithNpmHttp(name, path.join(tempDir, 'npm'), tempFile, logger, {
          registry: registries?.[0],
          authToken,
          cacheDir,
        }),
        downloadWitchPack(name, path.join(tempDir, 'pack'), logger, {
          registry: registries?.[0],
          authToken,
          cacheDir,
        }),
      ]
      return raceDownloadTasks(tasks)
    }, retry)
    logger.info(`${loggerPrefix} download tgz success!`)
    logger.info(`${loggerPrefix} tgzPath: ${tgzPath}\ntempDir: ${tempDir}`)
    // Extract the tarball
    await tar.x({ file: tgzPath, cwd: tempDir })

    logger.info(`${loggerPrefix} extract success!`)

    // Read package.json to get the main field
    const packageJsonPath = path.join(tempDir, 'package', 'package.json')
    const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, 'utf-8'))
    let mainFile = packageJson.main || 'index.js'
    if (dist && !mainFile.includes(dist) && packageJson.exports) {
      const exportPath = resolveExportTarget(packageJson.exports, dist)
      if (exportPath)
        mainFile = exportPath
    }
    // Read the main file content
    const mainFilePath = path.join(tempDir, 'package', mainFile)
    logger.info(`${loggerPrefix} mainFilePath: ${mainFilePath}`)

    const mainFileContent = await fsp.readFile(mainFilePath, 'utf-8')
    // Clean up: remove the temporary directory and tarball
    await fsp.rm(tempDir, { recursive: true, force: true })

    if (process.env.VITEST)
      await fsp.rm(distPackageJsonPath, { recursive: true, force: true })

    return mainFileContent
  }
  catch (error) {
    // Clean up in case of error
    if (tempDir)
      await fsp.rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

export function downloadWitchPack(name: string, tempDir: string, logger: any = console, options: NpmCliOptions = {}): DownloadTask {
  const promise = (async () => {
    await fsp.mkdir(tempDir, { recursive: true })
    const env = createNpmEnv(options.registry, options.authToken)
    const args = ['pack', name, '--pack-destination', tempDir]
    const shellOptions: any = {
      args,
      errorExit: false,
    }
    if (env)
      shellOptions.options = { env }
    const { result, status } = await jsShell('npm', shellOptions)
    if (status !== 0) {
      logger.error(result)
      throw new Error(typeof result === 'string' ? result : 'npm pack failed')
    }
    if (name.startsWith('@'))
      name = name.slice(1)
    const tarballPattern = `${name.replace(/[/@]/g, '-')}`
    const [tarballPath] = await fsp.readdir(tempDir).then(files => files.filter(file => file.match(tarballPattern)))
    return path.join(tempDir, tarballPath)
  })()
  return {
    promise,
    cancel: () => {},
  }
}

export function downloadWithNpmHttp(name: string, tempDir: string, tempFile: string, logger: any = console, options: NpmCliOptions = {}): DownloadTask {
  let streamTask: DownloadTask | undefined
  let cancelled = false
  const promise = (async () => {
    await fsp.mkdir(tempDir, { recursive: true })
    const env = createNpmEnv(options.registry, options.authToken)
    const args = ['view', name, 'dist.tarball']
    if (options.registry)
      args.push('--registry', options.registry)
    const shellOptions: any = {
      args,
      errorExit: false,
    }
    if (env)
      shellOptions.options = { env }
    const { result, status } = await jsShell('npm', shellOptions)
    if (status !== 0) {
      logger.error(result)
      throw new Error(typeof result === 'string' ? result : 'npm view failed')
    }
    const tarballUrl = result.trim()

    if (!tarballUrl) {
      const error = new Error(`[fetch-npm]: dist.tarball not found for package ${name}`)
      logger.error(error.message)
      throw error
    }
    const cachePath = getCacheFilePath(options.cacheDir, name, tarballUrl)
    if (cachePath && existsSync(cachePath))
      return cachePath
    const downloadTarget = cachePath ? createTempCachePath(cachePath) : path.join(tempDir, `${tempFile.replace(/@\d+\.\d+\.\d+/, '')}.tgz`)
    streamTask = streamTarballToFile(tarballUrl, downloadTarget, undefined)
    if (cancelled) {
      streamTask.cancel?.()
      throw new Error('[fetch-npm]: npm http download cancelled')
    }
    const downloadedPath = await streamTask.promise
    if (cachePath)
      return persistCacheFile(downloadedPath, cachePath)
    return downloadedPath
  })()
  return {
    promise,
    cancel: () => {
      cancelled = true
      streamTask?.cancel?.()
    },
  }
}

export function downloadWithHttp(name: string, tempDir: string, tempFile: string, logger: any = console, requestOptions: DownloadHttpOptions = {}): DownloadTask {
  let streamTask: DownloadTask | undefined
  let cancelled = false
  const promise = (async () => {
    await fsp.mkdir(tempDir, { recursive: true })
    let tarballUrl: string
    try {
      const registryFetchers = requestOptions.registries?.length
        ? requestOptions.registries.map(registryUrl => getTarballUrlFromCustomRegistry(name, registryUrl, requestOptions.headers))
        : [
            getTarballUrlFromRegistry(name, requestOptions.headers),
            getTarballUrlFromYarn(name, requestOptions.headers),
            getTarballUrlFromTencent(name, requestOptions.headers),
          ]
      tarballUrl = await Promise.any(registryFetchers)
    }
    catch (error) {
      logger.error(`[fetch-npm]: Failed to fetch tarball URL from all sources: ${error}`)
      throw error
    }

    const cachePath = getCacheFilePath(requestOptions.cacheDir, name, tarballUrl)
    if (cachePath && existsSync(cachePath))
      return cachePath
    const downloadTarget = cachePath ? createTempCachePath(cachePath) : path.join(tempDir, `${tempFile}.tgz`)
    streamTask = streamTarballToFile(tarballUrl, downloadTarget, requestOptions.headers)
    if (cancelled) {
      streamTask.cancel?.()
      throw new Error('[fetch-npm]: http download cancelled')
    }
    const downloadedPath = await streamTask.promise
    if (cachePath)
      return persistCacheFile(downloadedPath, cachePath)
    return downloadedPath
  })()

  return {
    promise,
    cancel: () => {
      cancelled = true
      streamTask?.cancel?.()
    },
  }
}

async function getTarballUrlFromRegistry(name: string, headers?: Record<string, string>): Promise<string> {
  return getTarballUrlFromRegistryBase('https://registry.npmjs.org', name, headers)
}

export async function getTarballUrlFromYarn(name: string, headers?: Record<string, string>): Promise<string> {
  return getTarballUrlFromRegistryBase('https://registry.yarnpkg.com', name, headers)
}

async function getTarballUrlFromTencent(name: string, headers?: Record<string, string>): Promise<string> {
  return getTarballUrlFromRegistryBase('https://mirrors.cloud.tencent.com/npm', name, headers)
}

async function getTarballUrlFromCustomRegistry(name: string, registryUrl: string, headers?: Record<string, string>): Promise<string> {
  return getTarballUrlFromRegistryBase(registryUrl, name, headers)
}

async function getTarballUrlFromRegistryBase(baseUrl: string, name: string, headers?: Record<string, string>): Promise<string> {
  const metadataUrl = buildPackageMetadataUrl(baseUrl, name)
  const metadata = await fetchRegistryMetadata(metadataUrl, headers)
  return resolveTarballFromMetadata(metadata)
}

function buildPackageMetadataUrl(baseUrl: string, name: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const pkgFragment = name.replace(/@(\d+\.\d+\.\d+)/, '/$1')
  return `${normalizedBase}/${pkgFragment}`
}

function streamTarballToFile(tarballUrl: string, tgzPath: string, headers?: Record<string, string>): DownloadTask {
  const protocol = new URL(tarballUrl).protocol
  const lib = protocol === 'https:' ? https : http
  const tgzFile = createWriteStream(tgzPath)
  let request: http.ClientRequest | undefined
  let finished = false

  const promise = new Promise<string>((resolve, reject) => {
    let settled = false
    const cleanupAndReject = (error: Error) => {
      if (settled)
        return
      settled = true
      finished = true
      tgzFile.destroy()
      fsp.rm(tgzPath, { force: true }).finally(() => {
        reject(error)
      })
    }

    tgzFile.on('error', cleanupAndReject)

    request = lib.get(tarballUrl, { headers }, (response) => {
      if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
        response.resume()
        cleanupAndReject(new Error(`[fetch-npm]: request failed with status ${response.statusCode} for ${tarballUrl}`))
        return
      }

      response.on('error', cleanupAndReject)
      response.pipe(tgzFile)
      tgzFile.on('finish', () => {
        if (settled)
          return
        settled = true
        finished = true
        tgzFile.close(() => resolve(tgzPath))
      })
    })

    request.on('error', cleanupAndReject)
    request.setTimeout(DEFAULT_DOWNLOAD_TIMEOUT, () => {
      request?.destroy(new Error(`[fetch-npm]: request timeout after ${DEFAULT_DOWNLOAD_TIMEOUT}ms for ${tarballUrl}`))
    })
  })

  return {
    promise,
    cancel: () => {
      if (finished)
        return
      request?.destroy(new Error('[fetch-npm]: download cancelled'))
      tgzFile.destroy()
      fsp.rm(tgzPath, { force: true }).catch(() => {})
    },
  }
}

async function raceDownloadTasks(tasks: DownloadTask[]): Promise<string> {
  let winner: DownloadTask | undefined
  try {
    const wrapped = tasks.map(task => task.promise.then(value => ({ value, task })))
    const { value, task } = await Promise.any(wrapped)
    winner = task
    return value
  }
  finally {
    for (const task of tasks) {
      if (!winner || task !== winner)
        task.cancel?.()
    }
  }
}
