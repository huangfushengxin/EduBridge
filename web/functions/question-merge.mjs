// 合并同一识别任务的原卷及答题卡。歧义记录留给人工确认。
export function questionKey(number) {
  if (typeof number !== "string") return "";
  const label = number.normalize("NFKC").trim().replace(/\s+/g, "")
    .replace(/^第/, "").replace(/题(?=\(|$)/, "").replace(/[、。.:](?=\(|$)/, "");
  const parts = /^(\d{1,4})((?:\((?:\d{1,3}|[a-z]|[一二三四五六七八九十])\))*)$/i.exec(label);
  if (!parts || Number(parts[1]) < 1) return "";
  const chinese = "一二三四五六七八九十";
  const children = parts[2].replace(/\(([^)]+)\)/g, (_, part) => {
    const ordinal = chinese.indexOf(part);
    const id = ordinal >= 0 ? String(ordinal + 1) : /^\d+$/.test(part) ? String(Number(part)) : part.toLowerCase();
    return "(" + id + ")";
  });
  return String(Number(parts[1])) + children;
}

export function teacherResult(marks) {
  const candidates = (marks ?? []).filter((mark) =>
    (mark.kind === "cross" || mark.kind === "check") && mark.scope !== "partial");
  if (candidates.some((mark) => mark.status !== "recognized" || mark.scope === "unknown")) return "unclear";
  const kinds = new Set(candidates.map((mark) => mark.kind));
  if (kinds.size !== 1) return "unclear";
  return kinds.has("cross") ? "wrong" : "right";
}

const unique = (items) => [...new Map(items.map((item) => [JSON.stringify(item), item])).values()];

function newestEdit(list) {
  return list.filter((question) => question.human)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
}

export function mergeQuestionRows(allQuestions, sourceAssets) {
  const assets = new Map(sourceAssets.map((asset) => [asset.assetId, asset]));
  const groups = new Map();
  for (const row of allQuestions) {
    const editedKey = questionKey(row.human?.number);
    const recognizedKey = row.field_status?.number === "recognized" ? questionKey(row.draft?.number ?? row.number) : "";
    const key = editedKey || recognizedKey || "unknown:" + row.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  function display(papers, sheets, fallback, conflict) {
    const p = papers.find((row) => row.stem) ?? papers[0];
    const s = sheets.find((row) => row.student_answer) ?? sheets[0];
    const representative = p ?? s ?? fallback;
    const paperId = p?.source_asset_id ?? null;
    const answerId = s ? s.answer_asset_id || s.source_asset_id : null;
    const marks = unique([...papers, ...sheets].flatMap((row) => row.teacher_marks ?? []));
    const hasNumber = Boolean(questionKey(representative.human?.number)) ||
      (representative.field_status?.number === "recognized" && Boolean(questionKey(representative.draft?.number ?? representative.number)));
    const matched = Boolean(p && s && hasNumber && !conflict);
    const grading = conflict ? "unclear" : teacherResult(marks);
    const answerStatus = s?.field_status?.answer ?? (s?.student_answer ? "recognized" : "missing");
    const location = conflict || (!hasNumber ? "题号不清，需人工确认对应关系"
      : !p && s ? "答题卡中的题号暂未匹配到原卷，可核对原图或修订题号"
        : p && !s ? "尚未匹配到答题卡中的同一题号" : null);
    const human = newestEdit([representative, ...papers, ...sheets]);
    const merged = {
      ...representative,
      stem: p?.stem ?? null,
      student_answer: s?.student_answer ?? null,
      teacher_marks: marks,
      teacher_result: grading,
      source_asset_id: paperId,
      source_page_index: assets.get(paperId)?.pageIndex ?? p?.source_page_index ?? null,
      answer_asset_id: answerId,
      answer_page_index: assets.get(answerId)?.pageIndex ?? s?.answer_page_index ?? s?.source_page_index ?? null,
      location_hint: location,
      field_status: {
        ...representative.field_status, stem: p?.field_status?.stem ?? "missing", answer: answerStatus,
        linkage: matched ? "recognized" : "uncertain", teacher: grading !== "unclear" ? "recognized" : marks.length ? "uncertain" : "missing",
      },
      draft: {
        ...(representative.draft ?? {}),
        stem_candidates: unique(papers.map((row) => row.stem).filter(Boolean)),
        answer_drafts: sheets.map((row) => row.draft),
      },
    };
    if (human) Object.assign(merged, {
      id: human.id, number: human.human.number, human: human.human, status: human.status,
      confirmed_version: human.confirmed_version, confirmed_at: human.confirmed_at,
      note: human.note, updated_at: human.updated_at,
    });
    return merged;
  }

  const out = [];
  for (const list of groups.values()) {
    const papers = list.filter((row) => assets.get(row.source_asset_id)?.kind === "paper");
    const sheets = list.filter((row) => assets.get(row.source_asset_id)?.kind === "sheet" || assets.get(row.answer_asset_id)?.kind === "sheet");
    const paperText = unique(papers.map((row) => row.stem));
    const answerText = unique(sheets.map((row) => row.student_answer).filter(Boolean));
    if (paperText.length > 1 || answerText.length > 1) {
      const hint = "同一题号出现不同题干或作答，请查阅各页原图并人工确认对应关系";
      for (const row of list) {
        out.push(display(papers.includes(row) ? [row] : [], sheets.includes(row) ? [row] : [], row, hint));
      }
      continue;
    }
    out.push(display(papers, sheets, list[0], null));
  }
  out.sort((a, b) => questionKey(a.number).localeCompare(questionKey(b.number), "zh-CN", { numeric: true }));
  return out.map((question, seq) => ({ ...question, seq }));
}
