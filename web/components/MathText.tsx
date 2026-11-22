import katex from '../vendor/katex/katex.mjs';
import '../vendor/katex/katex.min.css';
import { mathParts } from '../lib/math-transcription';

export function MathText({ text, empty = '未识别到内容，待人工核对', studentWork = false }: {
  text: string | null | undefined;
  empty?: string;
  studentWork?: boolean;
}) {
  if (!text) return <p className="text-muted-foreground">{empty}</p>;

  return <div className="math-transcription whitespace-pre-wrap break-words">{mathParts(text, studentWork).map((part, i) => {
    if ('formula' in part) {
      try {
        const html = katex.renderToString(part.formula, {
          displayMode: part.display, throwOnError: true, trust: false, strict: 'ignore',
          maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml',
        });
        return <span key={i} className={part.display ? 'block overflow-x-auto' : 'inline-block max-w-full align-middle overflow-x-auto'}
          dangerouslySetInnerHTML={{ __html: html }} />;
      } catch (error) {
        if (!(error instanceof katex.ParseError)) throw error;
      }
    }
    return <span key={i}>{part.text}</span>;
  })}</div>;
}
