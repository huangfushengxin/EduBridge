import { useRef, useState } from "react";
import { FlaskConical, Images, Loader2, PenLine } from "lucide-react";
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
    <div className="workspace-flow-page">
      <div className="workspace-heading"><div>
        <h1>演示样例</h1>
        <p>选择自制图片体验流程，或核对固定题的题干、作答与老师批改。</p>
      </div><span className="workspace-source-label">自制演示数据</span></div>
      <div className="workspace-demo-grid">
        <Card aria-busy={busy}>
          <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><Images className="size-5 text-primary" aria-hidden="true" />自制原卷与答题卡</CardTitle>
            <CardDescription>载入图片会创建独立任务。到确认页后，点击「开始识别」才会调用模型。</CardDescription></CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted p-2">
              {sampleFiles.map(({path,kind}) => <img key={kind} src={import.meta.env.BASE_URL + path} alt={kind === "paper" ? "自制样例原卷" : "自制样例答题卡"} className="aspect-[4/3] w-full rounded-lg bg-white object-contain" />)}
            </div>
            <Button className="w-fit" disabled={busy} onClick={() => void startSample()}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}{busy ? "正在载入图片…" : "使用自制图片开始"}
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><FlaskConical className="size-5 text-primary" aria-hidden="true" />固定题人工确认</CardTitle>
            <CardDescription>对照已有题目及老师批改，体验逐题人工核对。</CardDescription></CardHeader>
          <CardContent className="grid gap-3">
            <p className="rounded-lg bg-muted p-3 text-sm">{DEMO_QUESTION.stem}</p>
            <Button className="w-fit" variant="outline" onClick={() => navigate("/confirm?mode=demo")}>体验固定题人工确认</Button>
          </CardContent>
        </Card>
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
