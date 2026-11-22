# EduBridge Web 与 Qoder Sites Function

前端使用 React、TypeScript、Vite、Tailwind CSS 和 KaTeX。Qoder Sites Function 负责会话归属、图片存储、识别、诊断和审核。独立的 [FastAPI 服务](../math_service/README.md) 用 SymPy 验证适用的结构化命题。

## 本机开发

按 [项目说明](../README.md#本地运行) 启动模拟服务和 Vite。Vite 将 `/functions/v1/app` 代理到回环地址，默认端口 8000。可用 `PORT` 与 `FUNCTION_PORT` 分别设置服务端和代理端口。

要测试真实识别，在本地服务进程中配置下列环境变量，从此目录运行 `node --env-file=.env.local dev/function-local.mjs`。 `.env.local` 由开发者在本机创建并填写服务端配置。固定样例的模拟模式通过 `EB_MOCK_MODEL` 显式启用。

| 环境变量 | 用途 |
| --- | --- |
| `MODEL_BASE_URL`、`MODEL_API_KEY` | OpenAI 兼容模型服务地址及密钥 |
| `VISION_MODEL` | 图片识别模型 |
| `TUTOR_MODEL` | 错因分析与教学模型 |
| `REVIEW_MODEL` | 独立审核模型，须与内容生成模型来自不同模型系列 |
| `MATH_VERIFY_URL`、`MATH_VERIFY_TOKEN` | 数学服务根地址及访问口令 |

本地适配器使用进程内存存储任务和图片。正式站使用 Qoder Sites 私有存储和数据库。

## 构建与部署

```sh
npm run build
```

在 Qoder Sites 中使用 `dist/` 作为网页目录，`functions/` 作为 Function 目录，入口为 `functions/index.ts`。部署依赖既有项目的数据库和私有存储，在站点的服务端 Secret 中配置上表所列环境变量。 `docs/migrations/005_learning_sessions.sql` 是学习会话的增量迁移，依赖既有任务与存储结构。

函数健康检查路径为 `/functions/v1/app/api/health`。发布后可通过站内自制图片核对识别、人工确认、诊断、审核和复测。前端构建执行 TypeScript 检查，服务端流程回归命令见 [项目说明](../README.md#代码与验证)。

组件模板来源及第三方许可见 [PROVENANCE.md](PROVENANCE.md)。
