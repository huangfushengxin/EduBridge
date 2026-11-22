/**
 * 演示样例数据 —— 自行设计的脱敏演示题，未使用真实学生数据。
 * 与 PROJECT_BRIEF.md §3 的演示场景一致：基本不等式的等号可取性。
 */

export interface DemoQuestion {
  number: string;
  stem: string;
  studentAnswer: string;
  gradingResult: "wrong" | "right" | "ungraded" | "unclear";
  gradingNote: string;
  referenceAnswer: string;
}

export const DEMO_QUESTION: DemoQuestion = {
  number: "第 1 题",
  stem: "已知 0 < x ≤ 1，求函数 f(x) = x + 4/x 的最小值。",
  studentAnswer:
    "由基本不等式，x + 4/x ≥ 2·√(x · 4/x) = 4，当且仅当 x = 2 时取等号，所以 f(x) 的最小值为 4。",
  gradingResult: "wrong",
  gradingNote:
    "等号成立需要 x = 2，但题目要求 0 < x ≤ 1，x = 2 不在取值范围内，最小值不能取到 4。",
  referenceAnswer:
    "当 0 < x ≤ 1 时，f(x) − 5 = (x − 1)(x − 4)/x ≥ 0。等号只在 x = 1 时成立，所以最小值是 5。基本不等式给出的下界 4 在题设范围内取不到。",
};

export const GRADING_OPTIONS: { value: DemoQuestion["gradingResult"]; label: string }[] = [
  { value: "wrong", label: "判错" },
  { value: "right", label: "判对" },
  { value: "ungraded", label: "未批改" },
  { value: "unclear", label: "待确认（识别不清）" },
];
