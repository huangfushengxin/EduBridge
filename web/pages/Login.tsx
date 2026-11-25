import { useState, type FormEvent } from "react";
import { GraduationCap, Loader2, LockKeyhole } from "lucide-react";
import { PaperIllustration } from "@/components/PaperIllustration";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeError, signInWorkspace } from "@/lib/api";

export default function LoginPage({configured,onSignedIn}: {configured:boolean;onSignedIn:()=>Promise<void>}) {
  const [username,setUsername] = useState("");
  const [password,setPassword] = useState("");
  const [show,setShow] = useState(false);
  const [pending,setPending] = useState(false);
  const [error,setError] = useState("");

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !configured) return;
    setPending(true);
    setError("");
    try {
      await signInWorkspace(username.trim(),password);
      await onSignedIn();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return <main className="workspace-login">
    <div className="workspace-login-layout">
      <section className="workspace-hero workspace-login-intro" aria-labelledby="login-title">
        <div className="workspace-hero-copy">
          <div className="workspace-login-brand"><span className="workspace-logo"><GraduationCap size={24} aria-hidden="true" /></span>EduBridge AI</div>
          <h1 id="login-title">登录学习工作台</h1>
          <p>继续查看你的错题任务和复测记录。</p>
        </div>
        <PaperIllustration />
      </section>
      <section className="workspace-panel workspace-login-card" aria-labelledby="login-form-title">
        <h2 id="login-form-title" className="flex items-center gap-2 text-lg font-semibold"><LockKeyhole size={18} aria-hidden="true" />工作台账号</h2>
      <form className="grid gap-4" onSubmit={submit} aria-busy={pending}>
        <div className="grid gap-2">
          <Label htmlFor="workspace-user">账号</Label>
          <Input id="workspace-user" autoComplete="username" autoCapitalize="none" spellCheck={false}
            value={username} onChange={(event)=>setUsername(event.target.value)} maxLength={64} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="workspace-password">密码</Label>
          <div className="flex gap-2">
            <Input id="workspace-password" type={show ? "text" : "password"} autoComplete="current-password"
              value={password} onChange={(event)=>setPassword(event.target.value)} maxLength={128} required />
            <Button type="button" variant="outline" onClick={()=>setShow(!show)} aria-pressed={show}>{show ? "隐藏" : "显示"}</Button>
          </div>
        </div>
        {(error || !configured) && <p className="text-sm text-destructive" role="alert">{error || "站点登录配置尚未就绪。"}</p>}
        <Button type="submit" disabled={!configured || pending || !username.trim() || !password}>{pending && <Loader2 className="animate-spin" aria-hidden="true" />}{pending ? "正在登录…" : "登录"}</Button>
      </form>
      </section>
    </div>
  </main>;
}
