-- 在已有 app.tasks 之后执行。先在发布目标核对是否存在同名表和当前 schemaRef。
-- 保持既有学习数据和迁移记录。表需仅提供给服务端 Function 的受限服务凭据。
-- Qoder Sites 预检拒绝了带级联动作的版本。由任务删除路由先清理本表，再删除父任务。
CREATE TABLE app.learning_sessions (
  task_id uuid PRIMARY KEY REFERENCES app.tasks(id),
  owner_token_hash text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
