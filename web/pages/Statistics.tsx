import { BookOpen, CalendarDays, ChartNoAxesCombined, ChevronRight, CircleCheck, ClipboardCheck, FileText, GraduationCap, Layers3, Target, UploadCloud } from "lucide-react";
import { PaperIllustration } from "@/components/PaperIllustration";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { studyDay, summarizeStudy } from "@/lib/study-progress";
import { useStudyResults } from "@/lib/use-study-results";

const guide = [
  { to: "/library", title: "准备材料", detail: "原卷与老师已批改的答题卡" },
  { to: "/confirm?mode=custom", title: "核对识别", detail: "对照原图确认题干、作答与批改" },
  { to: "/learning", title: "诊断与复测", detail: "查看证据、练习并复测" },
];

export default function StatisticsPage() {
  const {results,loading,incomplete} = useStudyResults();
  const now = Date.now();
  const {days,count,right,retakeCount,diagnosedTasks,topics} = summarizeStudy(results,now);
  const percentage = retakeCount ? `${Math.round(right / retakeCount * 100)}%` : "—";
  const step = Math.max(1, Math.ceil(Math.max(...days.map(({count})=>count)) / 4));
  const limit = step * 4;
  const metrics = [
    {label:"今日已诊断错题",value:count,description:`累计已诊断 ${diagnosedTasks} 个任务`,icon:Target},
    {label:"今日错题类型",value:topics.length,description:topics.map(([topic,value])=>`${topic} ${value}`).join(" · ") || "暂无知识点记录",icon:Layers3},
    {label:"今日复测正确率",value:percentage,description:retakeCount ? `${right} / ${retakeCount} 题通过` : "暂无复测作答",icon:CircleCheck},
    {label:"近 7 天已诊断",value:days.reduce((sum, day)=>sum+day.count,0),description:"含今天的学习记录",icon:ChartNoAxesCombined},
  ];

  return <div className="workspace-page space-y-5">
    <div className="workspace-heading">
      <div><h1>学习概况</h1><p>跟进错题诊断、练习和复测。</p></div>
      <span className="workspace-date"><CalendarDays size={16} aria-hidden="true" />{studyDay(now)} · 北京时间</span>
    </div>
    {incomplete && <p role="status" className="workspace-status">部分记录暂时无法读取，统计根据已加载的记录计算。</p>}
    <div className="workspace-bento">
      <section className="workspace-hero">
        <div className="workspace-hero-copy">
          <p className="workspace-eyebrow"><GraduationCap size={17} aria-hidden="true" /> 高一数学错题诊断</p>
          <h2>从一份批改过的<br className="workspace-hero-break" />试卷开始</h2>
          <p>对照原卷、作答和老师批改，找到值得复盘的一步。</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild><Link to="/upload"><UploadCloud />上传材料</Link></Button>
            <Button asChild variant="outline"><Link to="/demo">演示样例</Link></Button>
          </div>
        </div>
        <PaperIllustration />
      </section>
      <section className="workspace-panel workspace-guide" aria-labelledby="guide-title">
        <div className="workspace-panel-heading"><h2 id="guide-title"><BookOpen size={18} aria-hidden="true" />使用指南</h2></div>
        <ol className="workspace-guide-list">
          {guide.map(({to,title,detail}, i) => <li key={to}>
            <Link to={to}><span className="workspace-guide-index" aria-hidden="true">{i + 1}</span>
              <span className="min-w-0"><strong>{title}</strong><small>{detail}</small></span>
              <ChevronRight size={16} className="ml-auto shrink-0" aria-hidden="true" />
            </Link>
          </li>)}
        </ol>
      </section>
    </div>
    <section className="workspace-metrics" aria-label="数据统计" aria-busy={loading}>
      {metrics.map(({label,value,description,icon:Icon})=><article className="workspace-panel workspace-metric" key={label}>
        <span className="workspace-metric-icon"><Icon size={19} aria-hidden="true" /></span>
        <div className="min-w-0"><h2>{label}</h2><strong>{loading ? "—" : value}</strong><small>{loading ? "正在读取记录" : description}</small></div>
      </article>)}
    </section>
    <div className="workspace-bento">
      <section className="workspace-panel workspace-trend" aria-labelledby="trend-title" aria-busy={loading}>
        <div className="workspace-panel-heading"><h2 id="trend-title"><ChartNoAxesCombined size={18} aria-hidden="true" />最近 7 天诊断错题数</h2><span>单位 · 题</span></div>
        {loading ? <p role="status" className="workspace-chart-status">正在读取学习记录…</p> : <>
          <div className="workspace-chart">
            <div className="workspace-chart-axis" aria-hidden="true">{[4,3,2,1,0].map((n)=><span key={n}>{n*step}</span>)}</div>
            <ol className="workspace-chart-bars" aria-label="每日完成诊断的错题数">
              {days.map(({date,count},index)=><li key={date} title={`${date} · ${count} 题`}>
                <div className="workspace-chart-slot">
                  <div className={`workspace-chart-bar ${index===6 ? "today" : ""}`} style={{height:count ? `${count / limit * 100}%` : "3px"}}>
                    <span>{count}</span>
                  </div>
                </div>
                <time dateTime={date}>{date.slice(5).replace("-","/")}</time>
              </li>)}
            </ol>
          </div>
          <p className="workspace-chart-status">{days.some((day)=>day.count) ? "按生成错因报告的日期统计，真实识别的自制样例也计入。" : "近 7 天还没有错题诊断记录。生成错因报告后，记录会出现在这里。"}</p>
        </>}
      </section>
      <section className="workspace-panel" aria-labelledby="workspace-tasks-title">
        <div className="workspace-panel-heading"><h2 id="workspace-tasks-title"><ClipboardCheck size={18} aria-hidden="true" />学习任务</h2></div>
        <div className="workspace-task-shortcut">
          <span className="workspace-metric-icon"><FileText size={19} aria-hidden="true" /></span>
          <p>在资源库查看已有任务、管理材料和继续复盘。</p>
          <Button asChild variant="outline"><Link to="/library">打开资源库</Link></Button>
        </div>
      </section>
    </div>
  </div>;
}
