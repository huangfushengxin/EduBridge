import { useEffect, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MathText } from "@/components/MathText";
import type { LearningView, ReportQuestion } from "@/lib/learning";

const statusLabels: Record<ReportQuestion["status"], string> = {
  pending: "待完成",
  passed: "本次通过",
  practice_needed: "仍需练习",
  needs_review: "待人工复核",
};
const diagnosticLabels = { right: "正确", wrong: "错误", partial: "部分正确" };
const reportNext: Record<string, string> = {
  diagnostic_ready: "完成诊断练习后可以生成讲解。",
  diagnostic_submitted: "生成并审核讲解后可以开始复测。",
  teaching_ready: "点击「开始变式复测」进入下一步。",
  retake_ready: "提交变式复测后，这里将显示本次结论。",
};
const dateTime = (value: string) => new Date(value).toLocaleString("zh-CN", {
  timeZone: "Asia/Shanghai", hour12: false,
});

function ReportRows({ questions, stages, topics }: {
  questions: ReportQuestion[];
  stages: Record<string, string>;
  topics: Record<string, string>;
}) {
  return (
    <ul className="grid gap-2">
      {questions.map((q) => (
        <li key={q.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-3 text-sm">
          <span className="font-medium">第 {q.number ?? "未编号"} 题</span>
          <Badge variant="outline">{statusLabels[q.status]}</Badge>
          <span className="text-muted-foreground">确认版本 {q.version}{q.topic && topics[q.topic] ? " · " + topics[q.topic] : ""}</span>
          <span className="text-muted-foreground">{q.completedAt ? "完成于 " + dateTime(q.completedAt) : stages[q.stage]}</span>
          {q.diagnosticResults && q.diagnosticResults.length > 0 && (
            <p className="w-full text-muted-foreground">
              诊断练习 · {q.diagnosticResults.map(result => diagnosticLabels[result]).join("、")}
            </p>
          )}
          {q.status === "pending" && reportNext[q.stage] && (
            <p className="w-full text-muted-foreground">{reportNext[q.stage]}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function LearningReport({ report, stages, topics }: {
  report: NonNullable<LearningView["report"]>;
  stages: Record<string, string>;
  topics: Record<string, string>;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>学习报告</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          开始于 {dateTime(report.startedAt)} · 复测结论只反映本次作答。
        </p>
        {report.questions.some(question => question.status === "pending") && (
          <p className="text-sm text-muted-foreground">还有题目在进行中。完成变式复测后，这里会显示本次结论。</p>
        )}
        {report.stale && <p role="status" className="text-sm">原题的确认版本有变化，以下是此前版本的记录。</p>}
        <ReportRows questions={report.questions} stages={stages} topics={topics}/>
        {report.history.length > 0 && <details>
          <summary className="cursor-pointer font-medium">历史批次（{report.history.length}）</summary>
          <div className="mt-3 grid gap-3">
            {report.history.map((entry, index) => (
              <div key={entry.retiredAt + "/" + index} className="grid gap-2">
                <p className="text-sm text-muted-foreground">归档于 {dateTime(entry.retiredAt)}{entry.simulated ? " · 模拟数据" : ""}</p>
                <ReportRows questions={entry.questions} stages={stages} topics={topics}/>
              </div>
            ))}
          </div>
        </details>}
      </CardContent>
    </Card>
  );
}

export function LearningPrint({ work, simulated }: { work: LearningView["work"]; simulated: boolean }) {
  const [mode, setMode] = useState<"questions" | "answers" | null>(null);
  const exercises = work.flatMap(({ question, items, retake }) => [
    ...items.map((item) => ({ item, number: question.number, kind: "诊断练习" })),
    ...(retake ? [{ item: retake, number: question.number, kind: "变式复测" }] : []),
  ]);
  const answered = exercises.filter(({ item }) => item.attempt?.answer);
  useEffect(() => {
    const clear = () => setMode(null);
    window.addEventListener("afterprint", clear);
    return () => window.removeEventListener("afterprint", clear);
  }, []);

  function print(next: NonNullable<typeof mode>) {
    flushSync(() => setMode(next));
    window.print();
  }

  if (!exercises.length) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2" aria-label="练习打印">
        <Button variant="outline" onClick={() => print("questions")}>打印题目</Button>
        <Button variant="outline" disabled={!answered.length} onClick={() => print("answers")}>打印已作答的答案</Button>
      </div>
      {mode && createPortal(
        <main className="learning-print">
          <h1>EduBridge · {mode === "questions" ? "练习题目" : "参考解答"}</h1>
          {simulated && <p>模拟数据</p>}
          {mode === "answers" && answered.length < exercises.length && <p>仅包含已完成评分的题目。</p>}
          {exercises.map(({ item, number, kind }, index) => {
            if (mode === "answers" && !item.attempt?.answer) return null;
            return (
              <section key={item.id}>
                <h2>{index + 1}. {kind}（原卷第 {number ?? "未编号"} 题）</h2>
                {mode === "questions" ? <>
                  <MathText text={item.stem}/>
                  {item.conditions.map((condition, i) => <MathText key={i} text={condition}/>)}
                  {item.options?.map(({ key, text }) => (
                    <div key={key}><span>{key}. </span><MathText text={text}/></div>
                  ))}
                  <div className="learning-print-writing" aria-hidden="true"/>
                </> : <MathText text={item.attempt!.answer!}/>}
              </section>
            );
          })}
        </main>,
        document.body,
      )}
    </>
  );
}
