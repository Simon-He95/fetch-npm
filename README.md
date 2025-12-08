## Vitesse

通过 `npm pack` 下载 *npm* 包，解压后，获取指定 `dist` 文件夹下的文件，然后读取文件返回文件内容字符串，并删除下载的包。

## TODO

- [x] 使用 `os.tmpdir()` + `fs.mkdtemp` 创建临时目录，避免直接在 `dist` 目录下 `chmod 777` 并提升多实例安全性。（`src/index.ts` 中 `fetchAndExtractPackage` 已切换到系统临时目录）
- [x] 扩展 `dist` 匹配策略，完整解析 `package.json#exports` 的字符串和条件对象，确保能命中 `types`, `default`, `node`, `browser` 等多层声明。（`src/index.ts` 新增 `resolveExportTarget` 递归解析）
- [x] 为 `downloadWithHttp`/`downloadWithNpmHttp` 添加超时与 HTTP 状态码检查，并在 `response` 失败时中断写入，避免永远挂起或写入半成品。（`src/index.ts` 现使用 `streamTarballToFile`，默认 15s 超时，可通过 `FETCH_NPM_TIMEOUT` 配置）
- [x] 修复 `getTarballUrlFrom*` 中 `Uint8Array[]` 直接 `toString()` 的拼接方式，多包体积时会插入逗号导致 JSON 解析失败；使用 `Buffer.concat`。（已在 `src/index.ts` 的三处 registry 请求中处理）
- [x] `downloadWithNpmHttp` 在拿不到 `dist.tarball` 时应当 `reject` 并 `trim` CLI 输出，避免返回空字符串让后续 `tar.x` 抛出难以定位的错误。（`src/index.ts` 现在会 `trim` 并返回明确错误）
- [x] 支持用户指定 `registry`、`auth token`，以及在 HTTP 请求头里透传，方便私有包与企业镜像环境。（`fetchAndExtractPackage` 新增 `registry`/`authToken`/`headers`，内部透传到 HTTP 与 npm CLI）
- [x] 提供可选缓存目录，避免频繁重复下载同一个包版本；支持 `fetchAndExtractPackage({ cacheDir })` 与 CLI `--cache-dir`。（缓存命中时跳过网络下载，命中失败会写入缓存）
- [x] CLI 入口 `cli.mjs` 目前只 `import('./dist/index.js')`，补充参数解析、帮助文档与 stdout 输出，真正当成命令行工具使用。（现支持 `--dist`、`--registry`、`--header`、`--auth-token`、`--output` 等参数）
- [x] `Promise.any` 下载成功后，主动 `AbortController`/`req.destroy()` 取消剩余 HTTP 请求，并删除临时 `.tgz`，节省带宽与磁盘。（`raceDownloadTasks` + `streamTarballToFile` 支持 `cancel`）
- [ ] 补充测试：覆盖 scoped 包、显式版本、download fallback（http/npm/pack）与失败清理等场景，保证关键路径稳定。（见 `test/index.test.ts`）

## :coffee:

[buy me a cup of coffee](https://github.com/Simon-He95/sponsor)

## CLI 使用

```bash
npx @simon_he/fetch-npm run <pkg> [--dist dist-suffix] [--registry https://registry.npmmirror.com] \
  [--header Authorization="Bearer <token>"] [--auth-token <token>] [--cache-dir ./.cache] [--output ./main.js]
```

- `--registry` 可以重复传入，按照顺序快速回退。
- `--header` 支持附加 HTTP 头，便于自定义认证方案。
- `--auth-token`（或设置 `FETCH_NPM_TOKEN`/`NPM_TOKEN`）会自动透传至 npm CLI 和 HTTP 请求。
- `--cache-dir` 用于复用已下载的 `.tgz` 文件（按包名 + tarball URL 加 `sha1` 存储），命中后会跳过网络请求。
- 使用 `--output` 将结果写入文件，否则直接输出到 `stdout`；配合 `--verbose` 可查看内部日志。
- 直接使用 API 时也可以传入 `fetchAndExtractPackage({ cacheDir: '.fetch-cache' })`。

## License

[MIT](./license)

## Sponsors

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.svg">
    <img src="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.png"/>
  </a>
</p>
