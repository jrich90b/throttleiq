import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourcePath = path.join(process.cwd(), "services/api/src/domain/llmDraft.ts");
const source = fs.readFileSync(sourcePath, "utf8");

type ParserBlock = {
  name: string;
  body: string;
};

const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function hasExportModifier(node: ts.Node): boolean {
  return !!node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword);
}

function functionBlocks(text: string): ParserBlock[] {
  const blocks: ParserBlock[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      if (hasExportModifier(node) && /^parse[A-Za-z0-9]+WithLLM$/.test(name)) {
        blocks.push({ name, body: node.getText(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return blocks;
}

function functionBlockByName(name: string): string {
  let body = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      body = node.getText(sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return body;
}

/**
 * A parser may keep its few-shots INLINE, or hand them off to an extracted prompt module
 * (`const examples = INBOUND_REPLY_ACTION_EXAMPLES;`). The de-tangle program actively wants the
 * second shape — source_size_ratchet:eval forces prompt surfaces out of llmDraft.ts — so this
 * contract must follow the examples rather than fail the move. We do NOT accept the reference on
 * faith: the named constant has to resolve to a non-empty array literal in a domain module, or a
 * parser could "satisfy" the contract by pointing at nothing.
 */
function referencedExamplesAreNonEmpty(constName: string): boolean {
  const domainDir = path.join(process.cwd(), "services/api/src/domain");
  const declaration = new RegExp(
    `export const ${constName}\\s*:?[^=]*=\\s*\\[\\s*(?:\\/\\/[^\\n]*\\n\\s*)*\\S`
  );
  for (const file of fs.readdirSync(domainDir)) {
    if (!file.endsWith(".ts")) continue;
    if (declaration.test(fs.readFileSync(path.join(domainDir, file), "utf8"))) return true;
  }
  return false;
}

function hasFewShotExamples(body: string): boolean {
  const referenced = body.match(/\bexamples\s*=\s*([A-Z][A-Z0-9_]*)\s*;/);
  return (
    /\bexamples\s*=\s*\[/.test(body) ||
    (!!referenced && referencedExamplesAreNonEmpty(referenced[1])) ||
    /"Examples:"/.test(body) ||
    /"Voice-style examples:"/.test(body) ||
    /"Good examples:"/.test(body) ||
    /"Examples that SHOULD/.test(body)
  );
}

const failures: string[] = [];

const helper = functionBlockByName("requestStructuredJson");
if (!helper.includes('type: "json_schema"')) {
  failures.push("requestStructuredJson must use OpenAI json_schema structured output.");
}
if (!helper.includes("strict: true")) {
  failures.push("requestStructuredJson must request strict structured output.");
}

const blocks = functionBlocks(source);
const structuredBlocks = blocks.filter(block => block.body.includes("requestStructuredJson("));

for (const block of structuredBlocks) {
  if (!/schemaName:\s*"[^"]+"/.test(block.body)) {
    failures.push(`${block.name} is missing schemaName in requestStructuredJson.`);
  }
  if (!/schema:\s*[A-Z0-9_]+_JSON_SCHEMA/.test(block.body)) {
    failures.push(`${block.name} is missing a *_JSON_SCHEMA contract.`);
  }
  if (!/Return only JSON/.test(block.body)) {
    failures.push(`${block.name} prompt must explicitly require JSON-only output.`);
  }
  if (!hasFewShotExamples(block.body)) {
    failures.push(`${block.name} has strict schema output but no prompt few-shot examples.`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} LLM parser contract check(s) failed.`);
  process.exit(1);
}

console.log(
  `LLM parser contract OK: ${structuredBlocks.length} structured parsers use strict schemas and prompt examples.`
);
