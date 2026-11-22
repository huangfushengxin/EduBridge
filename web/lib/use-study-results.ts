import { useEffect, useState } from "react";
import { readLearning } from "./learning";
import { studyResults, type StudyResult } from "./study-progress";
import { useUploads } from "./store";

export function useStudyResults() {
  const {tasks,sessionStatus} = useUploads();
  const [state,setState] = useState<{results: StudyResult[]; loading: boolean; incomplete: boolean}>({results:[],loading:true,incomplete:false});

  useEffect(() => {
    if (sessionStatus === "loading") return;
    if (sessionStatus === "error") {
      setState({results:[],loading:false,incomplete:true});
      return;
    }
    let pending: AbortController | undefined;
    const refresh = async () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      setState((previous)=>({...previous,loading:true}));
      const results: StudyResult[] = [];
      let incomplete = false;
      for (let start = 0; start < tasks.length && !controller.signal.aborted; start += 5) {
        const batch = await Promise.allSettled(tasks.slice(start,start+5).map(async ({id})=>
          studyResults(id,await readLearning(id,controller.signal))));
        for (const entry of batch) {
          if (entry.status === "fulfilled") results.push(entry.value);
          else incomplete = true;
        }
      }
      if (!controller.signal.aborted) setState({results,loading:false,incomplete});
    };
    void refresh();
    window.addEventListener("focus",refresh);
    return () => {
      window.removeEventListener("focus",refresh);
      pending?.abort();
    };
  },[tasks,sessionStatus]);

  return state;
}
