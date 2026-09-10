/** Count implementation without imports, whitespace or documentation; ADR 0039, ADR 0051. */
import ts from 'typescript';

export function sourceLines(text: string): { lines: number; physicalLines: number; commentLines: number; importLines: number; blankLines: number } {
  const source = ts.createSourceFile('kernel.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals = new Map<number, number>(); const declarations = new Map<number, number>();
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) { declarations.set(node.getStart(source), node.end); return; }
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateLiteralToken(node)) {
      literals.set(node.getStart(source), node.end);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const comments = new Set<number>(); const code = new Set<number>(); const imports = new Set<number>();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const start = scanner.getTokenStart();
    // The parser supplies contextual spans for regexes and template tails; a
    // standalone scanner cannot distinguish those from division or block ends.
    const importEnd = declarations.get(start); const end = importEnd ?? literals.get(start);
    if (end !== undefined) scanner.resetTokenState(end);
    if (token === ts.SyntaxKind.WhitespaceTrivia || token === ts.SyntaxKind.NewLineTrivia) continue;
    const target = importEnd !== undefined ? imports : token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia ? comments : code;
    const last = source.getLineAndCharacterOfPosition(scanner.getTokenEnd() - 1).line;
    for (let line = source.getLineAndCharacterOfPosition(start).line; line <= last; line++) target.add(line);
  }
  const physicalLines = source.getLineStarts().length - (text.length === 0 || /[\r\n\u2028\u2029]$/u.test(text) ? 1 : 0);
  const starts = source.getLineStarts(); let lines = 0; let commentLines = 0; let importLines = 0; let blankLines = 0;
  for (const [line, start] of starts.slice(0, physicalLines).entries()) {
    if (!text.slice(start, starts[line + 1]).trim()) blankLines++;
    else if (code.has(line)) lines++;
    else if (imports.has(line)) importLines++;
    else if (comments.has(line)) commentLines++;
  }
  return { lines, physicalLines, commentLines, importLines, blankLines };
}
