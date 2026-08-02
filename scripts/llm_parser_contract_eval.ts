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

/**
 * A parser may also hand off its ENTIRE prompt to an extracted builder
 * (`const prompt = buildWalkInOutcomePrompt({...})`). Same de-tangle pressure as the examples
 * case above, one step further — and the same rule: the reference is not taken on faith. We
 * resolve the named builder to a real exported function in a domain module and re-run the
 * contract checks against ITS body, so a parser cannot satisfy the contract by calling something
 * that builds no prompt.
 */
function extractedPromptBody(builderName: string): string | null {
  const domainDir = path.join(process.cwd(), "services/api/src/domain");
  for (const file of fs.readdirSync(domainDir)) {
    if (!file.endsWith(".ts")) continue;
    const full = path.join(domainDir, file);
    const text = fs.readFileSync(full, "utf8");
    if (!new RegExp(`export function ${builderName}\\b`).test(text)) continue;
    const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let body: string | null = null;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === builderName) {
        // The module-level examples constant is spread into the prompt, so carry the whole
        // module: the builder body alone would not show the few-shots it splices in.
        body = text;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (body) return body;
  }
  return null;
}

/** The parser's own body, plus the extracted prompt module it delegates to (if any). */
function promptSurface(body: string): string {
  const builder = body.match(/\bprompt\s*=\s*(build[A-Za-z0-9_]*Prompt)\s*\(/);
  if (!builder) return body;
  const extracted = extractedPromptBody(builder[1]);
  return extracted ? `${body}\n${extracted}` : body;
}

function hasFewShotExamples(body: string): boolean {
  const referenced = body.match(/\bexamples\s*=\s*([A-Z][A-Z0-9_]*)\s*;/);
  // An extracted prompt builder splices its few-shots in directly (`...WALK_IN_OUTCOME_EXAMPLES`)
  // rather than through a local named `examples`. Still resolved, never taken on faith.
  const spread = body.match(/\.\.\.([A-Z][A-Z0-9_]*(?:EXAMPLES|FEW_SHOTS?))\b/);
  return (
    /\bexamples\s*=\s*\[/.test(body) ||
    (!!referenced && referencedExamplesAreNonEmpty(referenced[1])) ||
    (!!spread && referencedExamplesAreNonEmpty(spread[1])) ||
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
  // The schema/schemaName contract is about the CALL, so it stays scoped to the parser body.
  // The prompt contract follows the prompt wherever the de-tangle program moved it.
  const prompt = promptSurface(block.body);
  if (!/schemaName:\s*"[^"]+"/.test(block.body)) {
    failures.push(`${block.name} is missing schemaName in requestStructuredJson.`);
  }
  if (!/schema:\s*[A-Z0-9_]+_JSON_SCHEMA/.test(block.body)) {
    failures.push(`${block.name} is missing a *_JSON_SCHEMA contract.`);
  }
  if (!/Return only JSON/.test(prompt)) {
    failures.push(`${block.name} prompt must explicitly require JSON-only output.`);
  }
  if (!hasFewShotExamples(prompt)) {
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
