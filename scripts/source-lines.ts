/** Exclude documentation without hiding implementation or literal contents; ADR 0039. */
import ts from 'typescript';

export function sourceLines(text: string): { lines: number; physicalLines: number; commentLines: number } {
  const source = ts.createSourceFile('kernel.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals = new Map<number, number>();
  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateLiteralToken(node)) {
      literals.set(node.getStart(source), node.end);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const comments = new Set<number>(); const code = new Set<number>();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const start = scanner.getTokenStart();
    // The parser supplies contextual spans for regexes and template tails; a
    // standalone scanner cannot distinguish those from division or block ends.
    const literalEnd = literals.get(start);
    if (literalEnd !== undefined) scanner.resetTokenState(literalEnd);
    if (token === ts.SyntaxKind.WhitespaceTrivia || token === ts.SyntaxKind.NewLineTrivia) continue;
    const target = token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia ? comments : code;
    const last = source.getLineAndCharacterOfPosition(scanner.getTokenEnd() - 1).line;
    for (let line = source.getLineAndCharacterOfPosition(start).line; line <= last; line++) target.add(line);
  }
  const physicalLines = source.getLineStarts().length - (text.length === 0 || /[\r\n\u2028\u2029]$/u.test(text) ? 1 : 0);
  const commentLines = [...comments].filter(line => !code.has(line)).length;
  return { lines: physicalLines - commentLines, physicalLines, commentLines };
}
