# EduBridge 数学验证服务

Qoder Sites Function 在服务端访问独立 FastAPI 服务。服务接收限定数量的结构化命题，并返回 passed、failed、unsupported 或 timeout。验证结论只覆盖提交的命题。生成题目与讲解还需要当前版本的独立审核。

## 本地运行

在项目根目录使用 Python 3.10 或更新版本执行。

```powershell
python -m pip install -r math_service/requirements.txt
python -m unittest math_service.test_verifier -v
# 以当前维护者的环境变量或密钥管理器设置 MATH_VERIFY_TOKEN 后启动
python -m uvicorn math_service.main:app --host 127.0.0.1 --port 8018
```

配置 Qoder Function 的 MATH_VERIFY_URL（服务的 HTTPS 根地址）和 MATH_VERIFY_TOKEN。部署时在 Python 服务与 Qoder Function 分别注入相同的长随机 Token。平台独立管理 Secrets。GET /health 用于服务探活，POST /verify 使用 Bearer 认证。


### 学习闭环使用本地真实数学服务

保持回环 FastAPI 服务运行。在项目根目录的另一个 PowerShell 窗口设置测试地址，使用与 FastAPI 服务相同的测试 Token。

```powershell
$env:EB_TEST_MATH_URL = 'http://127.0.0.1:8018'
$env:EB_TEST_MATH_TOKEN = $env:MATH_VERIFY_TOKEN
node web/dev/learning-flow-test.mjs
```

该套件通过实际数学 HTTP 接口验证正常流程，继续使用模拟模型。直接运行测试命令时默认使用模拟数学适配器。

## 支持范围

| 命题 | 条件 |
| --- | --- |
| 有限集合 | 整数集合的并集、交集和差集 |
| 代数等价 | 单实变量 x，多项式或有理式，明确区间和排除的点 |
| 方程和不等式 | 单实变量，受限多项式和有理式，预期有限点集或一个区间 |
| 基本不等式 | a*x+b/x 的正数域模板，核对 a、b、正域和等号点可达性 |

表达式仅由整数、有理数字面量、x 和允许的算术树节点构成。未支持的证明、超出边界的算式及求解不确定有明确结果。单次最多 3 个命题，受限计算在隔离进程执行，超过时限终止。测试文件包含定义域缺项、等号不可达等反例。

## 审核入口

审核明细需要同时持有任务的匿名会话凭据和单独的维护者审核凭据。后者在 Qoder Function 的 EB_REVIEWER_TOKEN Secret 中设置。通过受控终端、服务端脚本或维护工具使用 x-eb-session、x-eb-reviewer 两个请求头，调用 GET /api/tasks/{id}/learning/manual-review 查看待人工复核草稿。

人工核对后，向同一路径 POST JSON，字段为 artifactId、artifactVersion、decision、note。decision 取 pass 或 needs_human_review。通过需要当前版本已获独立模型审核通过，验证失败的结论会阻拦提交。人工记录保留实际工具状态并单独标记。
