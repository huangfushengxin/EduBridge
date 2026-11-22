type MathPart = { text: string } | { text: string; formula: string; display: boolean };

const delimited = /(?<!\\)\$\$[\s\S]+?\$\$|(?<![\\$])\$(?!\$)[^\n$]+?(?<!\\)\$(?!\$)|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g;
const bareCommand = /\\[a-zA-Z]+/;
const formulaLine = /^[a-zA-Z0-9\s()[\]{}.,:;|+\-*/^_=<>≤≥⩽⩾≦≧≠≈±×÷−√π∞∈∉∪∩∅∴²³]+$/u;
const mathOperator = /[=<>^_≤≥⩽⩾≦≧≠≈∈∉]/u;

// Build display segments without modifying the saved transcription.
export function mathParts(text: string, studentWork: boolean): MathPart[] {
  const parts: MathPart[] = [];
  const appendText = (value: string) => {
    if (!studentWork) {
      if (value) parts.push({ text: value });
      return;
    }
    for (const line of value.split(/(\r?\n)/)) {
      if (!line) continue;
      if (bareCommand.test(line) || (formulaLine.test(line) && mathOperator.test(line))) {
        parts.push({ text: line, formula: line, display: false });
      } else {
        parts.push({ text: line });
      }
    }
  };

  let start = 0;
  for (const match of text.matchAll(delimited)) {
    const fragment = match[0];
    const index = match.index;
    appendText(text.slice(start, index));
    const display = fragment.startsWith("$$") || fragment.startsWith("\\[");
    const delimiterLength = display || fragment.startsWith("\\(") ? 2 : 1;
    parts.push({ text: fragment, formula: fragment.slice(delimiterLength, -delimiterLength), display });
    start = index + fragment.length;
  }
  appendText(text.slice(start));
  return parts;
}
