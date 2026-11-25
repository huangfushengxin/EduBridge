import { useEffect, useState, type FormEvent } from "react";
import { Heart, PawPrint, UserRound } from "lucide-react";
import { PetPortrait, type PetAction } from "@/components/PetPortrait";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { petGrowth, pets, readProfile, rememberStudy, saveProfile, type LocalProfile, type Pet } from "@/lib/study-progress";
import { useStudyResults } from "@/lib/use-study-results";

const stages = ["幼年", "成长中", "成年"];
const reactions: {action:PetAction;text:string;expression:string}[] = [
  {action:"wag",text:"你好呀～",expression:"😊"},
  {action:"ears",text:"今天学习了吗？",expression:"👂"},
  {action:"cry",text:"不学习我就长不大了…",expression:"😢"},
  {action:"puff",text:"哈～歇口气再继续吧。",expression:"🥱"},
  {action:"scratch",text:"让我挠挠头，想一想。",expression:"🤔"},
  {action:"blink",text:"我们再做一道吧？",expression:"😉"},
];

function PetCompanion({pet,name,stage}: {pet:Pet;name:string;stage:number}) {
  const [turn,setTurn] = useState(0);
  const {action,text,expression} = reactions[turn % reactions.length];

  return <div className="workspace-pet-companion" data-reaction={action}>
    <div className="workspace-pet-bubble" role="status" aria-atomic="true">
      <span>{text}</span> <span className="workspace-pet-expression">{expression}</span>
    </div>
    <button type="button" className="workspace-pet-current" aria-label={`和${name}互动`} onClick={()=>setTurn((current)=>current+1)}>
      <PetPortrait pet={pet} stage={stage} motion={{action,turn}} />
      <span className="workspace-pet-tap" aria-hidden="true">轻点互动</span>
    </button>
  </div>;
}

export default function ProfilePage() {
  const [profile,setProfile] = useState(readProfile);
  const [nickname,setNickname] = useState(profile.nickname);
  const [feedback,setFeedback] = useState("");
  const {results,loading,incomplete} = useStudyResults();
  const {age,life,stage} = petGrowth(profile);
  const selected = pets.find(({id})=>id===profile.pet);

  useEffect(()=>{
    if (!loading) setProfile(rememberStudy(results));
  },[loading,results,profile.pet]);

  function update(profile: LocalProfile, message: string) {
    if (!saveProfile(profile)) {
      setFeedback("当前浏览器无法保存个人设置。");
      return;
    }
    setProfile(profile);
    setFeedback(message);
  }

  function saveNickname(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = nickname.trim();
    update({...readProfile(),nickname:name},"昵称已保存。");
    setNickname(name);
  }

  return <div className="workspace-page space-y-5">
    <div className="workspace-heading"><div><h1>个人中心</h1><p>设置昵称、选择学习伙伴并查看成长进度。</p></div></div>
    <div className="workspace-profile">
      <section className="workspace-panel" aria-labelledby="profile-title">
        <div className="workspace-panel-heading"><h2 id="profile-title">个人资料</h2><UserRound size={18} aria-hidden="true" /></div>
        <div className="workspace-profile-details">
          <span className="workspace-profile-avatar" aria-hidden="true">{profile.nickname ? [...profile.nickname][0] : <UserRound size={25} />}</span>
          <form className="grid gap-3" onSubmit={saveNickname}>
            <Label htmlFor="profile-nickname">我的昵称</Label>
            <Input id="profile-nickname" value={nickname} maxLength={24} placeholder="输入昵称" onChange={(e)=>setNickname(e.target.value)} />
            <p className="text-sm text-muted-foreground">个人设置与宠物进度保存在当前浏览器。</p>
            <Button className="w-fit" type="submit">保存昵称</Button>
          </form>
        </div>
      </section>
      <section className="workspace-panel" aria-labelledby="pet-title">
        <div className="workspace-panel-heading"><h2 id="pet-title">学习伙伴</h2><PawPrint size={18} aria-hidden="true" /></div>
        <div className="workspace-pet-content">
          <div className="workspace-pet-hero">
            <div><h3>{selected?.name ?? "选一只宠物伙伴"}</h3><p>{selected ? `${age} 岁 · ${stages[stage]}` : "领养后从 0 岁、0 生命值开始。"}</p>
              {selected && <><div className="workspace-life"><Heart size={17} aria-hidden="true" /> 生命值 {life} / 100</div>
                <progress max={100} value={life} aria-label="萌宠生命值" /></>}
            </div>
            {selected && <PetCompanion key={selected.id} pet={selected.id} name={selected.name} stage={stage} />}
          </div>
          <p className="text-sm text-muted-foreground">资源库每有一个任务标为「已诊断」，生命值加 10，每个任务只计一次。已有诊断也会补算，攒满 100 升一岁。</p>
          <div className="workspace-pet-choices" role="group" aria-label="选择宠物形象">
            {pets.map(({id,name})=><button type="button" key={id} aria-pressed={id===profile.pet}
              onClick={()=>{
                const saved = readProfile();
                if (saved.pet === id) return;
                update({...saved,pet:id},`已选择${name}。`);
              }}><PetPortrait pet={id} stage={id===profile.pet ? stage : 0} /><span>{name}</span></button>)}
          </div>
          {incomplete && <p className="text-sm text-muted-foreground" role="status">部分学习记录暂未同步。</p>}
        </div>
      </section>
    </div>
    {feedback && <p role="status" className="workspace-status">{feedback}</p>}
  </div>;
}
