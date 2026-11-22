import { useEffect, useState } from "react";
import { readLearning } from "./learning";
import { useUploads } from "./store";
import { taskDiagnosisStatus } from "./task-diagnosis";

type Status = ReturnType<typeof taskDiagnosisStatus> | "状态暂不可用";

export function useTaskDiagnoses(enabled: boolean) {
  const {tasks,sessionStatus} = useUploads();
  const [statuses,setStatuses] = useState<Record<string,Status>>({});

  useEffect(() => {
    if (!enabled || sessionStatus !== "ready") return;
    let pending: AbortController | undefined;
    const refresh = async () => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      for (let start = 0; start < tasks.length; start += 5) {
        const entries = await Promise.all(tasks.slice(start,start+5).map(async ({id}): Promise<[string,Status]> => {
          try {
            return [id,taskDiagnosisStatus(await readLearning(id,request.signal))];
          } catch {
            return [id,"状态暂不可用"];
          }
        }));
        if (request.signal.aborted) return;
        setStatuses((previous) => ({...previous,...Object.fromEntries(entries)}));
      }
    };
    void refresh();
    window.addEventListener("focus",refresh);
    return () => {
      window.removeEventListener("focus",refresh);
      pending?.abort();
    };
  },[enabled,tasks,sessionStatus]);

  return statuses;
}
