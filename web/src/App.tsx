import { ArrowUpRight, ChartNoAxesCombined, ClipboardCheck, FolderOpen, GraduationCap, UserRound } from "lucide-react";
import { Link, RouterProvider, useRouter } from "@/lib/router";
import { UploadProvider } from "@/lib/store";
import ConfirmPage from "@/pages/Confirm";
import DemoPage from "@/pages/Demo";
import HomePage from "@/pages/Home";
import LearningPage from "@/pages/Learning";
import ProfilePage from "@/pages/Profile";
import StatisticsPage from "@/pages/Statistics";
import UploadPage from "@/pages/Upload";
import "./workspace.css";

const nav = [
  {to:"/library",label:"资源库",icon:FolderOpen,paths:["/library"]},
  {to:"/upload",label:"诊断",icon:ClipboardCheck,paths:["/upload","/confirm","/learning"]},
  {to:"/statistics",label:"统计",icon:ChartNoAxesCombined,paths:["/","/statistics"]},
  {to:"/profile",label:"个人",icon:UserRound,paths:["/profile"]},
];
const stages = [{path:"/upload",to:"/upload",label:"上传材料"},
  {path:"/confirm",to:"/confirm?mode=custom",label:"识别与确认"},
  {path:"/learning",to:"/learning",label:"诊断与复测"}];

function Shell() {
  const { path, query } = useRouter();
  const active = nav.find(({paths})=>paths.includes(path));
  const currentStep = stages.find(({path:stepPath})=>stepPath===path);
  const hasRoute = !!active || path === "/demo" || path === "/home";

  return <div className="workspace-shell">
    <aside className="workspace-sidebar">
      <Link to="/" className="workspace-brand" aria-label="EduBridge AI 首页">
        <span className="workspace-logo"><GraduationCap size={22} aria-hidden="true" /></span><span>EduBridge AI</span>
      </Link>
      <nav className="workspace-nav" aria-label="主导航">
        {nav.map(({to,label,icon:Icon,paths})=><Link key={to} to={to} aria-current={paths.includes(path) ? "page" : undefined}>
          <Icon size={19} aria-hidden="true" /><span>{label}</span>
        </Link>)}
      </nav>
    </aside>

    <div className="workspace-main">
      <header className="workspace-top">
        <div><span>学习工作台</span><span aria-hidden="true">/</span><strong>{active?.label ?? (path === "/demo" ? "演示样例" : "项目介绍")}</strong></div>
        <Link to="/demo" className="workspace-demo-link">演示样例 <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </header>
      <main id="workspace-content" className="min-w-0 flex-1">
        {currentStep && <nav className="workspace-steps" aria-label="诊断流程">
          {stages.map(({path:stepPath,to,label},index)=><Link key={to} to={stepPath === "/learning" && query.has("task") ? `${to}?task=${encodeURIComponent(query.get("task") ?? "")}` : to}
            aria-current={path===stepPath ? "step" : undefined}><span>{index+1}</span>{label}</Link>)}
        </nav>}
        {(path === "/" || path === "/statistics") && <StatisticsPage />}
        {path === "/library" && <UploadPage key="library" library />}
        {path === "/upload" && <UploadPage key="diagnosis" />}
        {path === "/confirm" && <ConfirmPage />}
        {path === "/learning" && <LearningPage />}
        {path === "/demo" && <DemoPage />}
        {path === "/profile" && <ProfilePage />}
        {path === "/home" && <HomePage />}
        {!hasRoute && <div className="workspace-page"><h1 className="text-xl font-semibold">页面不存在</h1><Link to="/" className="workspace-text-link">返回工作台</Link></div>}
      </main>
      <footer className="workspace-footer"><Link to="/home">EduBridge AI · 2026 Qoder 高校创造力大赛</Link><span>公开演示使用自制或脱敏样例。</span></footer>
    </div>
  </div>;
}

export default function App() {
  return <UploadProvider><RouterProvider><Shell /></RouterProvider></UploadProvider>;
}
