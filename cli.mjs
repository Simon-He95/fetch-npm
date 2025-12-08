#!/usr/bin/env node --no-warnings
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf-8'))
const argv = process.argv.slice(2)
const parsed = parseArgs(argv)

if (parsed.help || parsed.h) {
  printHelp()
  process.exit(0)
}

if (parsed.version || parsed.v) {
  console.log(pkg.version)
  process.exit(0)
}

const packageName = parsed._[0] || parsed.name
if (!packageName) {
  console.error('[fetch-npm] Missing package name.\n')
  printHelp()
  process.exit(1)
}

const retry = parsed.retry ? Number.parseInt(parsed.retry, 10) : undefined
const authToken = parsed.authToken || parsed.auth || process.env.FETCH_NPM_TOKEN || process.env.NPM_TOKEN
const registries = parsed.registry?.length ? parsed.registry : undefined
const headers = buildHeaders(parsed.header)
const options = {
  name: packageName,
  dist: parsed.dist,
  retry: Number.isFinite(retry) ? retry : undefined,
  registry: registries?.length === 1 ? registries[0] : registries,
  authToken,
  headers,
  cacheDir: parsed.cacheDir,
  logger: parsed.verbose
    ? console
    : {
        info: () => {},
        error: msg => console.error(msg),
      },
}

try {
  const { fetchAndExtractPackage } = await import('./dist/index.js')
  const content = await fetchAndExtractPackage(options)
  const outputPath = parsed.output || parsed.out

  if (outputPath) {
    const resolvedPath = path.resolve(process.cwd(), outputPath)
    await writeFile(resolvedPath, content, 'utf-8')
    console.log(`[fetch-npm] Saved file to ${resolvedPath}`)
  }
  else {
    process.stdout.write(content)
  }
}
catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[fetch-npm] ${message}`)
  process.exit(1)
}

function parseArgs(args) {
  const result = { _: [] }
  const aliasMap = {
    h: 'help',
    v: 'version',
    d: 'dist',
    r: 'registry',
    o: 'output',
    a: 'authToken',
    c: 'cacheDir',
  }
  const multiKeys = new Set(['registry', 'header'])

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      result._.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split('=')
      const key = toCamelCase(rawKey)
      let value = inlineValue
      if (value === undefined) {
        if (i + 1 < args.length && !args[i + 1].startsWith('-'))
          value = args[++i]
        else
          value = true
      }
      assignArg(result, key, value, multiKeys)
      continue
    }
    if (arg.startsWith('-') && arg.length === 2) {
      const alias = aliasMap[arg.slice(1)]
      if (!alias) {
        result._.push(arg)
        continue
      }
      let value = true
      if (i + 1 < args.length && !args[i + 1].startsWith('-'))
        value = args[++i]
      assignArg(result, alias, value, multiKeys)
      continue
    }
    result._.push(arg)
  }

  return result
}

function assignArg(target, key, value, multiKeys) {
  if (multiKeys.has(key)) {
    target[key] = target[key] || []
    target[key].push(String(value))
  }
  else {
    target[key] = value
  }
}

function buildHeaders(headerEntries) {
  if (!headerEntries?.length)
    return undefined
  const headers = {}
  for (const entry of headerEntries) {
    const delimiterIndex = entry.indexOf('=')
    if (delimiterIndex <= 0)
      continue
    const headerKey = entry.slice(0, delimiterIndex).trim()
    const headerValue = entry.slice(delimiterIndex + 1).trim()
    if (!headerKey)
      continue
    headers[headerKey] = headerValue
  }
  return Object.keys(headers).length ? headers : undefined
}

function toCamelCase(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function printHelp() {
  const scriptName = path.basename(fileURLToPath(import.meta.url))
  console.log(`fetch-npm v${pkg.version}

Usage:
  ${scriptName} <package-name> [options]

Options:
  --dist <pattern>         Target dist path or substring inside exports.
  --registry <url>         Custom registry (repeatable).
  --header <k=v>           Additional HTTP header (repeatable).
  --auth-token <token>     Auth token (or use FETCH_NPM_TOKEN/NPM_TOKEN).
  --cache-dir <dir>        Store/reuse tarballs in the provided directory.
  --retry <count>          Retry attempts (default: 1).
  --output <file>          Save resolved file content instead of stdout.
  --verbose                Show internal log output.
  --help, -h               Show help.
  --version, -v            Show CLI version.
`)
}
