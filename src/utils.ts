import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import process from 'node:process'
import JSON5 from 'json5'

export const EXPORT_CONDITION_PRIORITY = [
  'import',
  'default',
  'require',
  'module',
  'node',
  'browser',
  'types',
]

export function resolveExportTarget(exportsField: unknown, dist: string): string | undefined {
  if (!exportsField)
    return undefined

  if (typeof exportsField === 'string')
    return exportsField.includes(dist) ? exportsField : undefined

  if (Array.isArray(exportsField)) {
    for (const entry of exportsField) {
      const match = resolveExportTarget(entry, dist)
      if (match)
        return match
    }
    return undefined
  }

  if (typeof exportsField === 'object') {
    const record = exportsField as Record<string, unknown>
    for (const key of EXPORT_CONDITION_PRIORITY) {
      if (key in record) {
        const match = resolveExportTarget(record[key], dist)
        if (match)
          return match
      }
    }
    for (const key of Object.keys(record)) {
      if (EXPORT_CONDITION_PRIORITY.includes(key))
        continue
      const match = resolveExportTarget(record[key], dist)
      if (match)
        return match
    }
  }

  return undefined
}

export function normalizeRegistries(registry?: string | string[]): string[] | undefined {
  if (!registry)
    return undefined
  const list = (Array.isArray(registry) ? registry : [registry])
    .map(item => item?.trim())
    .filter((item): item is string => Boolean(item))
  return list.length ? list : undefined
}

export function mergeHeaders(headers?: Record<string, string>, authToken?: string): Record<string, string> | undefined {
  let merged = headers ? { ...headers } : undefined
  if (authToken) {
    const hasAuthorization = merged && Object.keys(merged).some(key => key.toLowerCase() === 'authorization')
    if (hasAuthorization)
      return merged
    merged = { ...(merged || {}), authorization: `Bearer ${authToken}` }
  }
  return merged && Object.keys(merged).length ? merged : undefined
}

export function createNpmEnv(registry?: string, authToken?: string): NodeJS.ProcessEnv | undefined {
  if (!registry && !authToken)
    return undefined
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (registry)
    env.npm_config_registry = registry
  if (authToken)
    env.NPM_TOKEN = authToken
  return env
}

export async function fetchRegistryMetadata(metadataUrl: string, headers?: Record<string, string>) {
  const protocol = new URL(metadataUrl).protocol
  const lib = protocol === 'https:' ? https : http
  const data: Buffer[] = []
  await new Promise((resolve, reject) => {
    lib.get(metadataUrl, { headers }, (response) => {
      if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
        response.resume()
        reject(new Error(`[fetch-npm]: registry request failed with status ${response.statusCode} for ${metadataUrl}`))
        return
      }
      response.on('data', chunk => data.push(chunk))
      response.on('end', resolve)
      response.on('error', reject)
    }).on('error', reject)
  })

  return JSON5.parse(Buffer.concat(data).toString('utf-8'))
}

export function resolveTarballFromMetadata(metadata: any): string {
  if (metadata && metadata['dist-tags']) {
    const version = metadata['dist-tags'].latest
    const tarball = metadata.versions?.[version]?.dist?.tarball
    if (tarball)
      return tarball
  }
  const fallbackTarball = metadata?.dist?.tarball
  if (fallbackTarball)
    return fallbackTarball
  throw new Error('[fetch-npm]: Tarball url missing in registry metadata')
}

export function getCacheFilePath(cacheDir: string | undefined, packageName: string, identifier?: string): string | undefined {
  if (!cacheDir || !identifier)
    return undefined
  const safeName = packageName.replace(/[^\w.-]/g, '_')
  const hash = createHash('sha1').update(identifier).digest('hex')
  return path.join(cacheDir, `${safeName}-${hash}.tgz`)
}

export function createTempCachePath(cachePath: string): string {
  const dir = path.dirname(cachePath)
  const base = path.basename(cachePath)
  return path.join(dir, `${base}.tmp-${process.pid}-${Date.now()}`)
}

export async function persistCacheFile(tempPath: string, cachePath: string): Promise<string> {
  await fsp.mkdir(path.dirname(cachePath), { recursive: true })
  try {
    await fsp.rename(tempPath, cachePath)
  }
  catch (error: any) {
    if (error?.code === 'EXDEV') {
      await fsp.copyFile(tempPath, cachePath)
      await fsp.rm(tempPath, { force: true })
    }
    else if (error?.code === 'EEXIST') {
      await fsp.rm(tempPath, { force: true })
    }
    else {
      throw error
    }
  }
  return cachePath
}
