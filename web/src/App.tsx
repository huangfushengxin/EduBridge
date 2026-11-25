import { useEffect, useRef, useState } from "react";
import { BookOpen, ChartNoAxesCombined, ChevronRight, ClipboardCheck, FolderOpen, GraduationCap, LayoutGrid, Loader2, UserRound } from "lucide-react";
import { ApiError, describeError, readWorkspaceAccess, signOutWorkspace, type WorkspaceAccess } from "@/lib/api";
import { Link, RouterProvider, useRouter } from "@/lib/router";
import { UploadProvider } from "@/lib/store";
import ConfirmPage from "@/pages/Confirm";
import DemoPage from "@/pages/Demo";
import HomePage from "@/pages/Home";
import LearningPage from "@/pages/Learning";
import ProfilePage from "@/pages/Profile";
import StatisticsPage from "@/pages/Statistics";
import UploadPage from "@/pages/Upload";
import LoginPage from "@/pages/Login";
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

function Shell({logout}: {logout?:()=>void}) {
  const { path, query } = useRouter();
  const active = nav.find(({paths})=>paths.includes(path));
  const currentStep = stages.find(({path:stepPath})=>stepPath===path);
  const hasRoute = !!active || path === "/demo" || path === "/home";
  const content = useRef<HTMLElement>(null);
  const lastPath = useRef(path);

  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    content.current?.focus({ preventScroll: true });
  }, [path]);

  return <div className="workspace-shell">
    <a href="#workspace-content" className="workspace-skip" onClick={(event) => {
      event.preventDefault();
      content.current?.focus();
    }}>跳到主要内容</a>
    <aside className="workspace-sidebar">
      <Link to="/" className="workspace-brand" aria-label="EduBridge AI 首页">
        <span className="workspace-logo"><GraduationCap size={22} aria-hidden="true" /></span><span>EduBridge AI</span>
      </Link>
      <nav className="workspace-nav" aria-label="主导航">
        {nav.map(({to,label,icon:Icon,paths})=><Link key={to} to={to} aria-current={paths.includes(path) ? "page" : undefined}>
          <Icon size={19} aria-hidden="true" /><span>{label}</span>
        </Link>)}
      </nav>
      <Link to="/home" className="workspace-about" aria-current={path === "/home" ? "page" : undefined}><BookOpen size={19} aria-hidden="true" />项目介绍</Link>
    </aside>

    <div className="workspace-main">
      <header className="workspace-top">
        <div className="workspace-crumb"><LayoutGrid size={16} aria-hidden="true" /><Link to="/">学习工作台</Link><ChevronRight size={14} aria-hidden="true" /><strong>{currentStep?.label ?? (path === "/" || path === "/statistics" ? "学习概况" : active?.label ?? (path === "/demo" ? "演示样例" : path === "/home" ? "项目介绍" : "页面不存在"))}</strong></div>
        <div>
          <Link to="/demo" className="workspace-demo-link" aria-current={path === "/demo" ? "page" : undefined}>演示样例</Link>
          {logout && <button type="button" className="workspace-demo-link" onClick={logout}>退出登录</button>}
        </div>
      </header>
      <main id="workspace-content" ref={content} tabIndex={-1} className="min-w-0 flex-1">
        {currentStep && <nav className="workspace-steps" aria-label="诊断流程">
          {stages.map(({path:stepPath,to,label},index)=><Link key={to} to={stepPath === "/learning" && query.has("task") ? `${to}?task=${encodeURIComponent(query.get("task") ?? "")}` : to}
            aria-current={path===stepPath ? "step" : undefined}><span aria-hidden="true">{index+1}</span>{label}</Link>)}
        </nav>}
        {(path === "/" || path === "/statistics") && <StatisticsPage />}
        {path === "/library" && <UploadPage key="library" library />}
        {path === "/upload" && <UploadPage key="diagnosis" />}
        {path === "/confirm" && <ConfirmPage />}
        {path === "/learning" && <LearningPage />}
        {path === "/demo" && <DemoPage />}
        {path === "/profile" && <ProfilePage />}
        {path === "/home" && <HomePage />}
        {!hasRoute && <div className="workspace-flow-page"><div className="workspace-heading"><div><h1>页面不存在</h1><p>请从学习工作台选择页面。</p></div></div><Link to="/" className="workspace-demo-link w-fit">返回工作台</Link></div>}
      </main>
      <footer className="workspace-footer"><Link to="/home">EduBridge AI · 2026 Qoder 高校创造力大赛</Link><span>公开演示使用自制或脱敏样例。</span></footer>
    </div>
  </div>;
}

export default function App() {
  const [access,setAccess] = useState<WorkspaceAccess | null>(null);
  const [error,setError] = useState("");

  async function refreshAccess(expectSignedIn = false) {
    try {
      const current = await readWorkspaceAccess();
      if (expectSignedIn && !current.authenticated) throw new ApiError("login_session_unavailable", 401);
      setAccess(current);
      setError("");
    } catch (error) {
      if (!expectSignedIn && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) &&
          error instanceof ApiError && error.status === 404 && ["not_found","HTTP 404"].includes(error.message)) {
        setAccess({required:false,configured:false,authenticated:false});
        return;
      }
      throw error;
    }
  }

  useEffect(()=>{
    const refresh = () => void refreshAccess().catch((error)=>setError(describeError(error)));
    refresh();
    window.addEventListener("focus",refresh);
    return ()=>window.removeEventListener("focus",refresh);
  },[]);

  if (!access) return <main className="workspace-login">
    <div className="workspace-login-card workspace-panel" role="status">
      <p className="flex items-center gap-3">{!error && <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />}{error || "正在检查登录状态…"}</p>
      {error && <button type="button" className="workspace-demo-link" onClick={()=>void refreshAccess().catch((err)=>setError(describeError(err)))}>重试</button>}
    </div>
  </main>;
  if (access.required && !access.authenticated) return <LoginPage configured={access.configured} onSignedIn={()=>refreshAccess(true)} />;
  const logout = access.required ? ()=>{
    signOutWorkspace();
    setAccess({...access,authenticated:false});
  } : undefined;
  return <UploadProvider><RouterProvider><Shell logout={logout} /></RouterProvider></UploadProvider>;
}
