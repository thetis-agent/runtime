/** Count executable test declarations rather than id mentions in comments; ADR 0006, proposal §13.12. */
import ts from 'typescript';
type Value = string | number | boolean | null | Value[] | undefined;
type Environment = ReadonlyMap<string, Value>;
export interface Declaration { name: string; line: number; skipped: boolean }
function value(node: ts.Node, env: Environment): Value {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isIdentifier(node)) return env.get(node.text);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => value(item, env));
  if (ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return value(node.expression, env);
  if (ts.isConditionalExpression(node)) return value(node.condition, env) ? value(node.whenTrue, env) : value(node.whenFalse, env);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return value(node.left, env) === value(node.right, env);
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      if (/^[A-Z]{2}-\d{3}\b/u.test(text)) return text;
      const inserted = value(span.expression, env); if (inserted === undefined || Array.isArray(inserted)) return text;
      text += String(inserted) + span.literal.text;
    }
    return text;
  }
  return undefined;
}
function bind(name: ts.BindingName, item: Value, env: Map<string, Value>): void {
  if (ts.isIdentifier(name)) env.set(name.text, item);
  else if (ts.isArrayBindingPattern(name) && Array.isArray(item)) name.elements.forEach((entry, index) => { if (ts.isBindingElement(entry)) bind(entry.name, item[index], env); });
}
export function declarations(source: string, path: string): Declaration[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true); const result: Declaration[] = [];
  const names = new Set<string>();
  for (const statement of file.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'node:test') {
    const clause = statement.importClause; if (clause?.name) names.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) if (['test', 'it'].includes(item.propertyName?.text ?? item.name.text)) names.add(item.name.text);
  }
  const visit = (node: ts.Node, env: Map<string, Value>): void => {
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const items = value(node.expression, env); const declaration = node.initializer.declarations[0];
      if (Array.isArray(items) && declaration) { for (const item of items) { const nested = new Map(env); bind(declaration.name, item, nested); visit(node.statement, nested); } return; }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, value(node.initializer, env), env);
    if (ts.isCallExpression(node)) {
      const expression = node.expression; const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) ? expression.expression.text : '';
      const argument = node.arguments[0];
      if (names.has(name) && argument) { const title = value(argument, env); if (typeof title === 'string') result.push({ name: title, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, skipped: ts.isPropertyAccessExpression(expression) && ['skip', 'todo'].includes(expression.name.text) }); }
    }
    ts.forEachChild(node, child => { visit(child, env); });
  };
  visit(file, new Map()); return result;
}
