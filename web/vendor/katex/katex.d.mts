declare const katex: {
  renderToString(source: string, options: Record<string, unknown>): string;
  ParseError: new (...args: never[]) => Error;
};
export default katex;
