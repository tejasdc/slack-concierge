import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// These exact existing constructors own separate capture, projection, derived, cache,
// or isolated fixture databases. An added writable opening has no blanket file exemption.
const NON_LEDGER_WRITERS: Readonly<Record<string, readonly string[]>> = {
  'src/capture-state.ts': ['new Database(`${canonicalCaptureStateDir}/state.db`, { create: true, strict: true })'],
  'src/meaning-index.ts': ['new Database(path,{create:true})'],
  'src/presentation-message-worker.ts': ["new Database(join(stateDir,'presentation.db'),{create:true})"],
  'src/provider-history-worker.ts': ['new Database(temporary, { create: true, strict: true })'],
  'scripts/capture-drain-status.ts': ['new Database(`${stateDir}/state.db`, { create: true, strict: true })'],
  'scripts/usage-breakdown-reader.ts': ['new Database(cachePath)'],
};
const FIXTURE_WRITERS: Readonly<Record<string, readonly string[]>> = {
  'scripts/check-presentation-worker.ts': ["new Database(join(dir,'state.db'),{create:true})", "new Database(join(dir,'state.db'))"],
  'scripts/dispatch-claim-fixture.ts': ["new Database(join(process.env.CONCIERGE_STATE_DIR!,'state.db'))"],
  'scripts/release-application-compatibility.ts': ["new Database(join(workerState,'presentation.db'))", "new Database(join(workerState,'state.db'))"],
  'scripts/presentation-message-growth-fixtures.ts': ["new Database(':memory:')"],
  'scripts/storage-observation-check.ts': ["new Database(':memory:')"],
  'scripts/prepared-search-check.ts': ["new Database(':memory:')"],
  'scripts/topic-growth-fixtures.ts': ["new Database(':memory:')", "new Database(':memory:')"],
  'scripts/presentation-contract-fixture.ts': ["new Database(':memory:')"],
  'scripts/check-presentation-journal.ts': ["new Database(':memory:')"],
  'scripts/lab-growth-fixtures.ts': ["new Database(':memory:')", "new Database(':memory:')"],
  'scripts/presentation-growth-fixtures.ts': ["new Database(':memory:')", "new Database(':memory:')"],
  'scripts/history-delta-growth-fixtures.ts': ["new Database(':memory:')"],
  'scripts/receipt-projection-fixture.ts': ["new Database(':memory:')"],
  'scripts/owner-collection-growth-fixtures.ts': ["new Database(':memory:')"],
  'scripts/session-card-growth-fixtures.ts': ["new Database(':memory:')", "new Database(':memory:')"],
};

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'scripts'));
  return files;
}

function compact(source: string): string { return source.replace(/\s+/g, ''); }
function isSqliteModule(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) && node.text === 'bun:sqlite';
}
function isLiteralReadonly(node: ts.NewExpression): boolean {
  const options = node.arguments?.[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  let readonly = false;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)
      || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return false;
    if (property.name.text === 'readonly') readonly = property.initializer.kind === ts.SyntaxKind.TrueKeyword;
  }
  return readonly;
}

export function checkLedgerConstructors(root: string): { files: number; openings: number } {
  const errors: string[] = [];
  let openings = 0;
  const files = sourceFiles(root);
  for (const file of files) {
    const name = relative(root, file);
    const source = readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (tree.parseDiagnostics.length) {
      errors.push(`${name}: cannot parse TypeScript for SQLite constructor check`);
      continue;
    }
    const aliases = new Set(['Database']); // Also catches a conventional constructor from a local re-export.
    const namespaces = new Set<string>();
    for (const statement of tree.statements) {
      if (ts.isImportDeclaration(statement) && isSqliteModule(statement.moduleSpecifier)) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
          if ((binding.propertyName?.text ?? binding.name.text) === 'Database') aliases.add(binding.name.text);
        }
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && isSqliteModule(statement.moduleSpecifier))
        errors.push(`${name}: re-exported bun:sqlite constructor bypasses constructor check`);
    }
    const exceptions = [...(NON_LEDGER_WRITERS[name] ?? []), ...(FIXTURE_WRITERS[name] ?? [])].map(compact);
    const isConstructor = (expression: ts.Expression): boolean =>
      ts.isIdentifier(expression) && aliases.has(expression.text)
      || ts.isPropertyAccessExpression(expression) && expression.name.text === 'Database'
        && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')
          && node.arguments.some(isSqliteModule)) errors.push(`${name}: dynamic bun:sqlite import bypasses constructor check`);
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'open'
          && isConstructor(node.expression.expression)) errors.push(`${name}: SQLite Database.open bypasses constructor check`);
      }
      if (ts.isVariableDeclaration(node) && node.initializer && isConstructor(node.initializer))
        errors.push(`${name}: SQLite constructor alias bypasses constructor check`);
      if (ts.isNewExpression(node) && isConstructor(node.expression)) {
        openings++;
        const opening = node.getText(tree);
        if (isLiteralReadonly(node)) { ts.forEachChild(node, visit); return; }
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.arguments.includes(node)
          && ts.isIdentifier(parent.expression) && parent.expression.text === 'ledgerWriteResults') {
          ts.forEachChild(node, visit); return;
        }
        const canonical = compact(opening.replace(/^new\s+[\w$]+(?:\s*\.\s*Database)?/, 'new Database'));
        const exception = exceptions.indexOf(canonical);
        if (exception >= 0) exceptions.splice(exception, 1);
        else errors.push(`${name}: writable SQLite connection must use ledgerWriteResults or an exact registered non-ledger site: ${opening.slice(0, 120)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    for (const missing of exceptions) errors.push(`${name}: registered SQLite exception is missing: ${missing}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { files: files.length, openings };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error('SQLite constructor check requires a source root');
  console.log(JSON.stringify({ check: 'ledger-constructors', ...checkLedgerConstructors(root) }));
}
