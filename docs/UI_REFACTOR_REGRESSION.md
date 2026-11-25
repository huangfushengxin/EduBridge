
# EduBridge AI 全局界面重构验收

验收日期：2026-11-25（北京时间）。独立分支：`codex/edubridge-bento-ui`。原工作区为 `C:/Users/28385/Documents/Qoder/2026-11-16/b72f9663/EduBridge`，主分支起点 `4aa7bf6`。原有工作区文件和未提交内容保留，独立工作区以 `f873e51` 记录原有运行所需的工作区变更；归档、工作区补丁、原始状态表和旧版静态产物保存在原目录 `tmp/ui-refactor-baseline/`。

## 页面与实际业务范围

| 原入口 | 页面内容与此次重构 |
| --- | --- |
| `/#/`、`/#/statistics` | 学习概况、任务进度、统计摘要、最近任务。Bento 卡片按行动、进度和历史排列。 |
| `/#/home` | 产品介绍、材料要求、三个步骤和原演示入口。 |
| 登录门禁 | 原登录状态检查、账号密码表单、错误反馈、密码可见性和退出入口。项目没有独立注册页面。 |
| `/#/library` | 材料库、历史任务、进度、继续任务、查看学习结果。 |
| `/#/upload` | 上传试卷与答题卡、多页管理、预览、批次及任务结果、引导样例。 |
| `/#/confirm?mode=custom`、固定题确认 | 识别配置和进度、页码匹配、题干和学生步骤、教师批改、原图切页缩放、人工修订与保存。 |
| `/#/learning` | 同一路由内的错因假设、证据、针对性练习、AI 教学、复测、前后对比与报告。保留草稿、发布审核和证据不足状态。 |
| `/#/demo` | 固定演示题、来源标记、材料原图、老师批改、操作入口。 |
| `/#/profile` | 个人中心、会话提示、任务入口。 |
| 未知地址 | 页面不存在和返回工作台。 |

原业务链路为会话及任务 → 上传 → 排队、运行和轮询识别 → 人工对照老师批改并确认 → 错因假设与证据 → 练习 → 审核后的讲解与复测 → 本次结果与学习报告。全局侧栏、移动导航、空态、加载、表单、按钮、警告、原有确认交互共同使用白灰底色、低饱和度蓝、系统字体和项目已有 Lucide 图标。CSS 内置纸面示意，其余演示素材沿用原有资源，未引入付费素材或新依赖。数学沿用项目的 KaTeX 安全渲染组件。

### 原有 API 入口

下表路径均接在站点原有函数前缀之后。以既有代码实现为准，页面仍使用原客户端请求函数。

| 能力 | 路径 |
| --- | --- |
| 探活与门禁 | `/api/health`、`/api/auth/{status,login}`、`/api/session`。退出在客户端清除工作台令牌。 |
| 任务与材料 | `/api/tasks`、`/api/tasks/{id}`、`/api/tasks/{id}/assets`、`/api/tasks/{id}/assets/order`、`/api/assets/{id}`、`/api/assets/{id}/content` |
| 识别 | `/api/recognition-config`、`/api/tasks/{id}/recognize`、`/api/jobs/{id}/run`、`/api/jobs/{id}`、`/api/tasks/{id}/recognition` |
| 人工确认 | `/api/tasks/{id}/questions`、`/api/questions/{id}/revision`、`/api/questions/{id}/confirm`、`/api/tasks/{id}/confirmation[s]` |
| 学习、审核、复测与报告 | `/api/tasks/{id}/diagnose`、`/api/tasks/{id}/learning`、`/api/tasks/{id}/learning/{advance,manual-review,retake}`、`/api/items/{id}/attempts`、`/api/diagnoses/{id}/teach`。报告读取学习状态。 |
| 维护路由 | `/api/storage-test`、`/api/storage-test/{id}`、`/api/model-connectivity` |
| 外部数学服务 | `GET /health`、`POST /verify`，由原有站点函数代理，UI 无直连。 |

## 回归结果

“通过”限于证据列所写的测试环境。浏览器业务用仓库自制题目和真实上传文件，服务端使用仓库明确标识的本地测试适配器。未调用付费模型。公网使用重构后发布的站点运行一轮三张自制图片的真实识别，其余真实模型阶段的覆盖范围见下表。

| # | 检查 | 结果 | 实测证据及覆盖范围 |
| --- | --- | --- | --- |
| 1 | 页面路由、导航 | 通过 | 10 个页面状态直接进入，检查移动与桌面导航及未知路由。 |
| 2 | 登录及用户状态 | 通过（本地） | 浏览器检查密码可见性、错误密码反馈、正确密码登录以及退出回到门禁。接口脚本覆盖会话及限流。公网当前门禁关闭。 |
| 3 | 多页试卷上传 | 通过（公网 API） | 同一真实站点任务上传原卷两页，页码 0、1，下载内容与文件逐字节一致。37 项多页识别脚本通过。浏览器文件选择器自动操作超时，手动多选交互未形成结论。 |
| 4 | 手写答题卡上传 | 通过 | 本地页面上传并展示仓库样例。公网同一多页任务上传手写答题卡并逐字节回读。 |
| 5 | AI 题目识别 | 通过（公网真实模型） | 配置接口返回 configured=true、simulated=false；从 HTTP 202 排队，经三个材料批次到 HTTP 200 succeeded，返回 4 条题号记录。本地浏览器与 90 项脚本覆盖状态展示。 |
| 6 | 数学公式 | 通过 | 学习页检测到 13 个 KaTeX 渲染节点，含变量与不等式，并检查原题对照。 |
| 7 | 原卷与答题卡题号匹配 | 部分通过 | 本地浏览器核对来源、切页及 125% 缩放。公网第 2 题题干、作答合并成功，第 7 题题干返回整题 7，答题卡返回 7(1)、7(2)，这两条小问缺配对题干。合并逻辑不在此次提交范围。 |
| 8 | 教师批改结果 | 通过（本地） | 原图红叉及教师结论显示，仍以老师批改为原始依据。 |
| 9 | 人工确认及保存 | 通过（本地） | 固定题确认及样例识别后确认均实测，确认结果可继续进入学习流程。 |
| 10 | 错因诊断及证据 | 通过（本地测试响应） | 浏览器展示诊断假设、学生步骤证据。脚本覆盖证据不足与审核门槛。 |
| 11 | 针对性练习生成 | 通过（本地测试响应） | 打开练习、作答提交并查看结果，提交前未展示题解。 |
| 12 | AI 教学讲解 | 通过（本地测试响应）／真实数学服务联测未全部通过 | 浏览器从练习进入讲解和复测。使用真实 SymPy 的独立 HTTP 联测中，重构前后均出现讲解数学核验超时；新分支对未通过核验的讲解保留待审核状态。真实模型未调用。 |
| 13 | 复测生成及提交 | 通过（本地测试响应） | 打开复测，提交前无题解，提交后显示“本次通过”。 |
| 14 | 前后测对比 | 通过（本地） | 报告同屏展示针对性练习作答结果、复测结果。 |
| 15 | 学习报告 | 通过（本地） | 完成样例全流程后生成报告，实测进入报告并查看结果。 |
| 16 | 历史记录和持久化 | 部分通过 | 公网通过独立 HTTP 请求回读本次任务及三张材料。本地浏览器刷新后仍能查看任务和报告，进度脚本 32 项通过。公网报告持久化未验收。 |
| 17 | 按钮、弹窗及表单 | 部分通过 | 验证导航、登录错误、样例加载、原图查看、保存确认、作答、进度与结果。原生打印及逐个边缘控件未穷举。 |
| 18 | 超时、网络异常 | 部分通过 | 本地脚本覆盖识别/学习超时、错误恢复与审核失败。公网真实模型超时、客户端断网后恢复未验收。 |
| 19 | 电脑、平板和移动端 | 通过 | 10 个视图在 1280、768、375 CSS 像素下共 30 项检查通过，文档无横向溢出。 |
| 20 | 控制台和页面性能 | 部分通过 | 核心流程无应用控制台错误，排除了测试环境的 favicon 请求。已取得构建体积，未做真实设备 Web Vitals 压测。 |

### 构建与命令结果

| 命令 | 结果 |
| --- | --- |
| 在 `web/` 执行 `npm run build`（含 TypeScript） | 原始与新版均通过。新版主 JS 630.15 kB（gzip 192.39 kB），主 CSS 211.74 kB（gzip 35.75 kB）。旧版分别为 619.44／190.20 kB、206.66／34.80 kB。Vite 已有单块体积告警仍出现。 |
| `node web/dev/smoke-test.mjs` | 本地 HTTP 105/105。 |
| `node web/dev/learning-flow-test.mjs` | 原有测试适配器断言 120 项通过。 |
| `node web/dev/multipage-recognition-test.mjs`、`node web/dev/recognition-modes.mjs` | 分别 37、90 项通过。 |
| `node web/dev/workspace-progress-test.mjs`、`node web/dev/run-schema-check.mjs` | 分别 32、52 项通过。 |
| 原有工作区登录测试、`node web/dev/repair-regression.mjs` | 登录、错误、会话和限流通过；修复回归脚本退出码 0。 |
| `python -B -m unittest math_service.test_verifier -v` | 真实 SymPy 单元测试 7/7。 |
| `learning-flow-test.mjs` 指向本机 FastAPI `/verify` | 实际观察到 HTTP 200 和 `symbolic_check_passed`。重构前后学习流程联测均出现 7 秒数学工作进程超时，完整联测退出码 1；新分支发生于受限定义域讲解。UI 提交前后函数、业务库、数学服务和测试文件无差异。 |
| `node --check` 遍历 `web/functions/*.mjs`、`git diff --check f873e51` | 无语法与补丁空白错误。环境无 Deno，未执行 Deno 检查。 |

### 页面截图

重构前使用原公网版本实拍，重构后使用已构建的本地版本实拍。截图保存在本机可视化交付目录 `C:/Users/28385/.codex/visualizations/2026/11/23/01a20832-74d8-7502-a6ac-9eae40130e5f/`，文件统一以 `edubridge-` 开头。

| 页面 | 重构前 | 重构后 |
| --- | --- | --- |
| 学习概况 | `before-overview.jpg` | `after-overview.jpg` |
| 材料上传 | `before-upload.jpg` | `after-upload.jpg` |
| 固定演示题／人工确认 | `before-confirm.jpg` | `after-confirm.jpg` |
| 识别结果、证据、报告与登录 | — | `after-recognition.jpg`、`after-learning.jpg`、`after-report.jpg`、`after-login.jpg` |

### 修改清单

- `web/src/App.tsx`、`web/src/globals.css`、`web/src/workspace.css`，统一导航、工作台框架、视觉变量、响应式布局与键盘焦点。
- `web/pages/{Home,Login,Profile,Statistics,Upload,Demo,Confirm,RecognitionPanel,Learning}.tsx`，覆盖现存路由、确认子视图及学习各阶段。
- `web/components/LearningReport.tsx`、`web/components/PaperIllustration.tsx`，学习报告与首页纸面示意。
- `web/components/ui/{alert,button,card,input,textarea}.tsx`，共用交互样式。
- `docs/UI_REFACTOR_REGRESSION.md`，本次回归与发布记录。

### Qoder Sites 与回滚

- 站点：<https://edubridge-ai-7m9lo2rrc2g.qoder.zone/#/demo>。原发布记录为 `01a207ce-7049-7d33-ab1a-72fb97b0c1d8`，旧入口为 `index-AeOMU4Fs.js` 和 `index-Df2hf83n.css`。公网主页、健康检查、门禁状态接口均实测 HTTP 200，门禁状态为关闭。
- 更新候选：原发布会话目录 `C:/Users/28385/Documents/Qoder/2026-11-17/dcf7d1da/edubridge-publish/dist-ui-bento/`，65 个文件与新版构建 SHA-256 一致，主入口资源为 `index-nYK8-nzZ.js` 和 `index-BZ-dKTvK.css`。
- Qoder 原会话重启后恢复 Sites 工具，预检通过（artifact_verified、canPublish=true、无阻塞），并发布到原域名。新版 Release `01a21294-3858-73cb-8b80-457aaf8d93eb`，部署 `01a21292-e654-7cab-a2a6-59fb9b8129e8`，发布工作流 action `8150c8f0-0ec0-4da1-bbcb-a2ad9522a942`。生成的发布描述文件记录了同一站点和新版构建。站点保留 SPA 模式、原 `functions/index.ts`、数据库、私有存储、函数和既有 Secret 配置。未提交比赛。
- 公网 HTTP 验收：首页、生产 JS/CSS、健康检查、门禁状态均 200，生产 JS/CSS 两个资源与本地构建逐字节一致。带同源条件的匿名会话和测试任务创建为 201。两页原卷与一页答题卡上传及回读成功，识别真实完成。只产生一个使用自制资料的公网验收任务。此轮未继续公网诊断、讲解、复测和报告。Windows 浏览器工具无法可靠确认当前 URL，停止该渠道的新版本浏览器验收。新版截图为已验证部署的同一构建的本地实拍。
- Git 回滚在独立分支对 UI 提交执行 `git revert a0042ec`。回撤后的运行基线为 `f873e51`；原主分支和原工作区无需重置。
- 站点回滚复用原站点和原函数，使用发布镜像内保留的旧 `dist/` 重新发布。验证发布版本、旧资源指纹、演示页和探活接口。备份还保留了原项目 `tmp/ui-refactor-baseline/web-dist/` 的构建。
