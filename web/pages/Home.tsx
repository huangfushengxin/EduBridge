import { ClipboardCheck, FileImage, GraduationCap } from "lucide-react";
import { MathText } from "@/components/MathText";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";

const steps = [
  { icon: FileImage, title: "上传材料", text: "分别上传原卷和老师已批改的答题卡。" },
  { icon: ClipboardCheck, title: "确认识别", text: "对照原图，核对题干、作答步骤和批改结果。" },
  { icon: GraduationCap, title: "诊断与复测", text: "查看错因证据，完成练习与复测，生成学习报告。" },
];

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6 sm:py-12">
      <section className="grid items-center gap-9 rounded-3xl border border-border bg-card p-6 sm:p-10 lg:grid-cols-[1.2fr_0.8fr] lg:gap-14">
        <div className="space-y-5">
          <p className="text-sm font-semibold text-primary">高一数学 · 错题诊断</p>
          <h1 className="text-4xl font-semibold leading-[1.16] tracking-tight sm:text-5xl lg:text-6xl">
            找到出错的那一步
          </h1>
          <p className="max-w-lg text-base leading-7 text-muted-foreground sm:text-lg">
            从老师批改过的试卷出发，在原作答里找证据。完成一道针对性练习，再用变式题检验这次复习。
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <Button asChild size="lg"><Link to="/upload">开始上传</Link></Button>
            <Button asChild size="lg" variant="outline"><Link to="/demo">查看演示</Link></Button>
          </div>
        </div>
        <div className="rounded-2xl bg-primary p-5 text-primary-foreground sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-current/20 pb-4">
            <h2 className="text-lg font-semibold">一次错因核对</h2>
            <p className="text-sm">演示样例</p>
          </div>
          <dl className="mt-4 grid gap-4 text-sm">
            <div>
              <dt className="font-medium opacity-85">题设范围</dt>
              <dd><MathText text={"当 $0<x\\le 1$ 时，求 $x+4/x$ 的最小值。"} /></dd>
            </div>
            <div className="rounded-lg bg-background/95 p-3 text-foreground">
              <dt className="font-semibold">学生原步骤</dt>
              <dd><MathText text="当 $x=2$ 时取等号，所以最小值为 $4$。" /></dd>
            </div>
            <div>
              <dt className="font-medium opacity-85">待验证错因</dt>
              <dd><MathText text="可能遗漏了取等点必须在题设范围内的条件。" /></dd>
            </div>
          </dl>
        </div>
      </section>
      <section aria-label="学习流程" className="mt-7 grid gap-5 rounded-2xl border border-border bg-card p-6 md:grid-cols-3 md:gap-8 sm:px-8">
        {steps.map(({icon: Icon, title, text}) => (
          <div key={title} className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-primary">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <div className="space-y-1">
              <h2 className="font-semibold">{title}</h2>
              <p className="text-sm leading-6 text-muted-foreground">{text}</p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
