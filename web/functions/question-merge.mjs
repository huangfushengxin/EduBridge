// 合并同一识别任务的原卷及答题卡。歧义记录留给人工确认。
const subLabel = "[0-9]{1,3}|[a-z]|[一二三四五六七八九十]";
const subMarker = String.raw`(?:\((?:${subLabel})\)|（(?:${subLabel})）|\[(?:${subLabel})\]|［(?:${subLabel})］|【(?:${subLabel})】|〔(?:${subLabel})〕)`;

const bracketPattern = new RegExp(subMarker, "gi");
const clauseMarkerPattern = new RegExp(String.raw`(?:^|[\r\n，,。；;！？!?：:]|[.]\s+)[ \t\u3000]*((?:${subMarker}[ \t\u3000]*)+)`, "gi");
const pathPartPattern = /\([^()]+\)/g;

export function questionKey(number) {
  if (typeof number !== "string") return "";
  const label = number.normalize("NFKC").replace(/\s+/g, "")
    .replace(bracketPattern, (part) => "(" + part.slice(1, -1) + ")")
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

// Only start-of-clause markers form a directory. Inline function arguments and
// repeated or non-consecutive labels cannot supply a sub-question stem.
function markedStem(stem, path, insideNumberedSection = false) {
  const markers = [...stem.matchAll(clauseMarkerPattern)].map((match) => ({
    key: questionKey("1" + match[1]).slice(1),
    start: match.index + match[0].indexOf(match[1]),
    end: match.index + match[0].length,
  }));
  const parent = path.slice(0, -1).join("");
  const suffix = path.at(-1);
  const ordinal = (key) => /^\([1-9][0-9]*\)$/.test(key) ? Number(key.slice(1, -1))
    : /^\([a-z]\)$/.test(key) ? key.charCodeAt(1) - 96 : 0;
  const siblings = markers.filter(({ key }) => key.startsWith(parent) &&
    /^\([^()]+\)$/.test(key.slice(parent.length)) &&
    /^\([a-z]\)$/.test(key.slice(parent.length)) === /^\([a-z]\)$/.test(suffix));
  // At the top level, A/B/... can be multiple-choice options. Without a
  // numbered section anchoring them, their role needs human confirmation.
  if ((insideNumberedSection || parent || !/^\([a-z]\)$/.test(suffix)) && siblings.length >= 2 &&
      siblings.every(({ key }, index) => ordinal(key.slice(parent.length)) === index + 1)) {
    const first = siblings[0];
    const index = siblings.findIndex(({ key }) => key === parent + suffix);
    if (index >= 0) {
      const selected = siblings[index];
      const following = siblings[index + 1] ?? markers.find(({ key, start }) =>
        start > selected.start && (!key.startsWith(parent) || key === parent));
      const prefix = stem.slice(0, path.length === 1 ? first.start : markers[0].start).trim();
      const segment = stem.slice(selected.end, following?.start).trim();
      return segment ? [prefix, segment].filter(Boolean).join(" ") : null;
    }
  }

  if (path.length < 2 || (!insideNumberedSection && /^\([a-z]\)$/.test(path[0]))) return null;
  const root = path[0];
  const roots = markers.filter(({ key }) => /^\([^()]+\)$/.test(key) &&
    /^\([a-z]\)$/.test(key) === /^\([a-z]\)$/.test(root));
  if (roots.length < 2 || roots.some(({ key }, index) => ordinal(key) !== index + 1)) return null;
  const rootIndex = roots.findIndex(({ key }) => key === root);
  if (rootIndex < 0) return null;
  const section = markedStem(stem.slice(roots[rootIndex].end, roots[rootIndex + 1]?.start), path.slice(1), true);
  return section ? [stem.slice(0, roots[0].start).trim(), section].filter(Boolean).join(" ") : null;
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

  function display(papers, sheets, fallback, conflict, inherited = null) {
    const p = papers.find((row) => row.stem) ?? papers[0];
    const s = sheets.find((row) => row.student_answer) ?? sheets[0];
    const representative = inherited ? s : p ?? s ?? fallback;
    const paperId = p?.source_asset_id ?? inherited?.paper?.source_asset_id ?? null;
    const answerId = s ? s.answer_asset_id || s.source_asset_id : null;
    const marks = unique([...(inherited ? [] : papers), ...sheets].flatMap((row) => row.teacher_marks ?? []));
    const hasNumber = Boolean(questionKey(representative.human?.number)) ||
      (representative.field_status?.number === "recognized" && Boolean(questionKey(representative.draft?.number ?? representative.number)));
    const matched = Boolean(p && s && hasNumber && !conflict);
    const grading = conflict ? "unclear" : teacherResult(marks);
    const answerStatus = s?.field_status?.answer ?? (s?.student_answer ? "recognized" : "missing");
    const location = conflict || (!hasNumber ? "题号不清，需人工确认对应关系"
      : !p && s ? "答题卡中的题号暂未匹配到原卷，可核对原图或修订题号"
        : p && !s ? "尚未匹配到答题卡中的同一题号" : null);
    const human = newestEdit([representative, ...(inherited ? [] : papers), ...sheets]);
    const merged = {
      ...representative,
      stem: inherited?.stem ?? p?.stem ?? null,
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
        stem_candidates: inherited ? [inherited.stem] : unique(papers.map((row) => row.stem).filter(Boolean)),
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

  const isPaper = (row) => assets.get(row.source_asset_id)?.kind === "paper";
  function findParent(key) {
    for (let parent = key; parent.endsWith(")");) {
      parent = parent.slice(0, parent.lastIndexOf("("));
      const candidates = (groups.get(parent) ?? []).filter(isPaper);
      if (!candidates.length) continue;
      const [paper] = candidates;
      if (!paper.human && paper.field_status?.stem === "recognized" && paper.stem &&
          candidates.every((candidate) => !candidate.human && candidate.source_asset_id === paper.source_asset_id && candidate.stem === paper.stem)) {
        const stem = markedStem(paper.stem, key.slice(parent.length).match(pathPartPattern));
        if (stem) return { paper, stem };
      }
      // The closest printed parent exists. Do not skip it to guess from an ancestor.
      return { unmatched: true, paper: candidates.length === 1 ? paper : null };
    }
    return null;
  }

  const out = [];
  for (const [key, list] of groups) {
    const papers = list.filter(isPaper);
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
    if (!papers.length && sheets.length && !key.startsWith("unknown:")) {
      const parent = findParent(key);
      if (parent?.stem) {
        out.push(display([parent.paper], sheets, sheets[0], null, parent));
        continue;
      }
      if (parent?.unmatched) {
        out.push(display([], sheets, sheets[0], "找到原卷上级题号，小问题干不明确，请对照原图人工确认", parent));
        continue;
      }
    }
    out.push(display(papers, sheets, list[0], null));
  }
  out.sort((a, b) => questionKey(a.number).localeCompare(questionKey(b.number), "zh-CN", { numeric: true }));
  return out.map((question, seq) => ({ ...question, seq }));
}
