// 运行 schema-check.ts：用项目已有的 rolldown（vite 8 依赖）打包为单文件 ESM 后执行。
// 仅开发用，不部署。用法：在 web 目录执行 node dev/run-schema-check.mjs
import { rolldown } from "rolldown";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(dir, ".schema-check.bundle.mjs");
const build = await rolldown({ input: path.join(dir, "schema-check.ts"), platform: "node" });
await build.write({ file: outfile, format: "esm" });
await build.close();
await import(pathToFileURL(outfile).href);