import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createTempCachePath,
  getCacheFilePath,
  mergeHeaders,
  normalizeRegistries,
  persistCacheFile,
  resolveExportTarget,
} from '../src/utils'

const cleanupDirs: string[] = []

afterEach(async () => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop()
    if (dir)
      await fsp.rm(dir, { recursive: true, force: true })
  }
})

describe('resolveExportTarget', () => {
  it('picks string export containing target', () => {
    expect(resolveExportTarget('./dist/index.js', 'dist/index.js')).toBe('./dist/index.js')
    expect(resolveExportTarget('./dist/index.js', 'dist/types.d.ts')).toBeUndefined()
  })

  it('resolves nested exports map', () => {
    const exportsField = {
      '.': {
        import: './esm/index.js',
        require: './cjs/index.js',
      },
      './types': {
        default: './dist/types/index.d.ts',
      },
    }
    expect(resolveExportTarget(exportsField, 'esm/index.js')).toBe('./esm/index.js')
    expect(resolveExportTarget(exportsField, 'dist/types/index.d.ts')).toBe('./dist/types/index.d.ts')
  })
})

describe('registry helpers', () => {
  it('normalizes registries list', () => {
    expect(normalizeRegistries(undefined)).toBeUndefined()
    expect(normalizeRegistries(' https://registry.npmjs.org ')).toEqual(['https://registry.npmjs.org'])
    expect(normalizeRegistries(['', 'https://a', ' https://b '])).toEqual(['https://a', 'https://b'])
  })

  it('merges headers and auth token', () => {
    expect(mergeHeaders(undefined, 'token')).toEqual({ authorization: 'Bearer token' })
    expect(mergeHeaders({ Authorization: 'Basic foo' }, 'token')).toEqual({ Authorization: 'Basic foo' })
    expect(mergeHeaders({ 'x-custom': '1' }, undefined)).toEqual({ 'x-custom': '1' })
  })
})

describe('cache helpers', () => {
  it('creates deterministic cache path', () => {
    const cachePath = getCacheFilePath('./.cache', '@scope/pkg', 'https://example.com/pkg.tgz')
    expect(cachePath).toMatch(/\.cache\/_scope_pkg-[a-f0-9]{40}\.tgz$/)
  })

  it('creates unique temp path for cache entry', () => {
    const tempPath = createTempCachePath('/tmp/cache/pkg.tgz')
    expect(tempPath).toMatch(/pkg\.tgz\.tmp-\d+-\d+$/)
  })

  it('persists cache file by moving temp file', async () => {
    const dir = await fsp.mkdtemp(path.join(tmpdir(), 'fetch-npm-cache-'))
    cleanupDirs.push(dir)
    const tempFile = path.join(dir, 'temp.tgz')
    const cacheFile = path.join(dir, 'pkg.tgz')
    await fsp.writeFile(tempFile, 'hello cache', 'utf-8')

    const result = await persistCacheFile(tempFile, cacheFile)
    expect(result).toBe(cacheFile)
    expect(await fsp.readFile(cacheFile, 'utf-8')).toBe('hello cache')
    await expect(fsp.access(tempFile)).rejects.toThrow()
  })
})
