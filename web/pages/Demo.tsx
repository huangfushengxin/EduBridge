import { useRef, useState } from "react";
import { FlaskConical, PenLine } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link, useRouter } from "@/lib/router";
import { DEMO_QUESTION } from "@/lib/demo";
import { createTask, describeError, listAssets, uploadAsset } from "@/lib/api";
import { useUploads } from "@/lib/store";

const sampleFiles = [
  {path:"examples/paper.png",name:"自制样例-原卷.png",kind:"paper"},
  {path:"examples/sheet.png",name:"自制样例-答题卡.png",kind:"sheet"},
] as const;

export default function DemoPage() {
  const { navigate } = useRouter();
  const { selectTask, refresh } = useUploads();
  const sampleTask = useRef<string | null>(null);
  const creating = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function startSample() {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setError("");
    try {
      const files = await Promise.all(sampleFiles.map(async (sample) => {
        const response = await fetch(import.meta.env.BASE_URL + sample.path);
        if (!response.ok || !response.headers.get("content-type")?.includes("image/png")) {
          throw new Error("演示图片暂不可用，请刷新后重试。");
        }
        return {...sample,file:new File([await response.blob()],sample.name,{type:"image/png"})};
      }));
      const task = sampleTask.current ?? (await createTask({kind:"demo",studentAlias:"自制样例 · 基本不等式"})).id;
      sampleTask.current = task;
      const { items } = await listAssets(task);
      for (const sample of files) {
        if (!items.some((item) => item.kind === sample.kind)) await uploadAsset(task,sample.kind,sample.file);
      }
      await selectTask(task);
      await refresh();
      navigate("/confirm?mode=custom");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <div>
        <div className="flex items-center gap-2">
          <FlaskConical className="size-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">演示样例</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          选择自制图片跑一遍完整流程，或先阅读固定题目的批改与参考答案。
        </p>
      </div>

      <Alert>
        <AlertTitle>用自制样例体验完整流程</AlertTitle>
        <AlertDescription>
          原卷与答题卡均为自制。点击后将创建独立任务并载入图片，进入确认页后可手动开始真实识别。
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} onClick={() => void startSample()}>
          {busy ? "正在载入图片…" : "使用自制图片开始"}
        </Button>
        <Button variant="outline" onClick={() => navigate("/confirm?mode=demo")}>体验固定题人工确认</Button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            演示原卷（文字版）
            <Badge variant="outline">演示</Badge>
          </CardTitle>
          <CardDescription>固定演示题的题干</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="rounded-lg bg-muted p-3 text-sm leading-relaxed">
            <span className="mr-1 font-medium">{DEMO_QUESTION.number}：</span>
            {DEMO_QUESTION.stem}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            演示答题卡（文字版）
            <Badge variant="outline">演示</Badge>
          </CardTitle>
          <CardDescription>学生作答步骤与老师批改结果</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="rounded-lg border border-border p-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <PenLine className="size-3.5" />
              学生作答
            </p>
            <p className="text-sm leading-relaxed">{DEMO_QUESTION.studentAnswer}</p>
          </div>
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p className="mb-1 text-xs font-medium text-destructive">老师批改：判错</p>
            <p className="text-sm leading-relaxed">{DEMO_QUESTION.gradingNote}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">人工参考解答（演示后核对用）</CardTitle>
          <CardDescription>用于核对演示题的正确解法</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="rounded-lg bg-muted p-3 text-sm leading-relaxed">{DEMO_QUESTION.referenceAnswer}</p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        <Link to="/upload" className="underline underline-offset-2">改用自己的原卷与答题卡</Link>
      </p>
    </div>
  );
}
