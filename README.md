# EduBridge AI

EduBridge AI 帮助高一学生和辅导老师复盘集合、函数和基本不等式错题。系统从老师批改过的试卷及答题卡中读取题干和作答，由用户对照原图确认，再围绕原作答证据安排诊断练习、讲解和变式复测。

[Qoder Sites 公网演示](https://edubridge-ai-7m9lo2rrc2g.qoder.zone/#/demo)

## 体验流程

1. 打开「演示样例」，用站内自制原卷和答题卡开始。
2. 点击「开始识别」，对照图片核对题干、学生作答和老师批改，再确认错题。
3. 进入错因诊断，查看引用的学生步骤或题目条件，完成诊断练习。
4. 阅读通过审核的针对性讲解，完成变式复测，查看学习报告。
5. 在学习工作台查看诊断统计，选择一个学习伙伴。每个有效诊断任务奖励 10 点生命值。

## 本地运行

需要 Node.js 22.13 或更新的 22.x 版本，或 Node.js 24 及以上。首次在 `web` 目录安装依赖。

```sh
cd web
npm ci
```

分别打开两个终端，在 `web` 目录运行前端和模拟服务。

```powershell
# 终端一
$env:EB_MOCK_MODEL = '1'
npm run dev:function
```

```sh
# 终端二
npm run dev
```

打开 Vite 显示的地址，通过「演示样例」体验模拟闭环。模拟服务仅识别内置的两张图片，任务和素材存于内存。实际模型、数学服务配置及部署目录见 [Web 与服务端说明](web/README.md)。

## 代码与验证

| 路径 | 用途 |
| --- | --- |
| `web/src`、`web/pages` | React 工作台、图片核对、诊断和复测 |
| `web/functions` | Qoder Sites Function、私有任务和存储、模型调用、审核与评分 |
| `math_service` | FastAPI 与 SymPy 数学验证 |
| `web/dev` | 模拟服务、测试和自制测试数据 |

从项目根目录运行核心回归。

```sh
node web/dev/learning-flow-test.mjs
node web/dev/multipage-recognition-test.mjs
node web/dev/recognition-modes.mjs
node --experimental-strip-types web/dev/workspace-progress-test.mjs
node web/dev/run-schema-check.mjs
```

数学验证服务的安装与回归命令见 [Math Service](math_service/README.md)。前端发布产物由 `web` 目录下的 `npm run build` 生成。

老师批改保留为原始依据。诊断给出有证据的错因假设。数学验证只覆盖支持的结构化命题，复测结果只反映本次作答。演示材料为自制样例。第三方组件来源和许可见 [模板来源](web/PROVENANCE.md)。
