import { ArrowRight, BookOpen, CalendarDays, ChartNoAxesCombined, CircleCheck, Layers3, Target } from "lucide-react";
import { Link } from "@/lib/router";
import { studyDay, summarizeStudy } from "@/lib/study-progress";
import { useStudyResults } from "@/lib/use-study-results";

export default function StatisticsPage() {
  const {results,loading,incomplete} = useStudyResults();
  const now = Date.now();
  const {days,count,right,retakeCount,diagnosedTasks,topics} = summarizeStudy(results,now);
  const percentage = retakeCount ? `${Math.round(right / retakeCount * 100)}%` : "—";
  const step = Math.max(1, Math.ceil(Math.max(...days.map(({count})=>count)) / 4));
  const limit = step * 4;
  const metrics = [
    {label:"今日已诊断错题",value:count,description:`累计已诊断 ${diagnosedTasks} 个任务`,icon:Target,color:"mint"},
    {label:"今日错题类型",value:topics.length,description:topics.map(([topic,value])=>`${topic} ${value}`).join(" · ") || "暂无知识点记录",icon:Layers3,color:"sand"},
    {label:"今日复测正确率",value:percentage,description:retakeCount ? `${right} / ${retakeCount} 题通过` : "暂无复测作答",icon:CircleCheck,color:"mint"},
    {label:"近 7 天已诊断",value:days.reduce((sum, day)=>sum+day.count,0),description:"含今天的学习记录",icon:ChartNoAxesCombined,color:"sand"},
  ];

  return <div className="workspace-page">
    <div className="workspace-heading">
      <div><h1>学习概况</h1><p>查看错题诊断和复测进度。</p></div>
      <span className="workspace-date"><CalendarDays size={15} aria-hidden="true" />{studyDay(now)}</span>
    </div>
    {incomplete && <p role="status" className="workspace-status">部分记录暂时无法读取，统计根据已加载的记录计算。</p>}
    <div className="workspace-overview">
      <section className="workspace-panel" aria-labelledby="metric-title" aria-busy={loading}>
        <div className="workspace-panel-heading"><h2 id="metric-title">数据统计</h2><span>北京时间</span></div>
        <div className="workspace-metrics">
          {metrics.map(({label,value,description,icon:Icon,color})=><div className="workspace-metric" key={label}>
            <span className={`workspace-metric-icon ${color}`}><Icon size={17} aria-hidden="true" /></span>
            <div className="min-w-0"><p>{label}</p><strong>{loading ? "—" : value}</strong><small>{loading ? "正在读取记录" : description}</small></div>
          </div>)}
        </div>
      </section>
      <section className="workspace-panel workspace-guide" aria-labelledby="guide-title">
        <div className="workspace-panel-heading"><h2 id="guide-title">使用指南</h2><BookOpen size={18} aria-hidden="true" /></div>
        <div className="workspace-guide-body">
          <p><strong>适合高一学生和辅导老师</strong><br />从老师批改过的试卷与答题卡出发，找出集合、函数和基本不等式中的可能错因。</p>
          <ol>
            <li>在资源库保存原卷和答题卡。</li>
            <li>进入诊断，核对识别出的题目与作答。</li>
            <li>完成诊断练习、讲解和变式复测。</li>
          </ol>
          <Link to="/demo" className="workspace-text-link">使用自制样例 <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      </section>
      <section className="workspace-panel workspace-trend" aria-labelledby="trend-title" aria-busy={loading}>
        <div className="workspace-panel-heading"><h2 id="trend-title">最近 7 天诊断错题数</h2><span>单位 · 题</span></div>
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
    </div>
  </div>;
}
