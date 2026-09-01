import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "../../../tools/layer-checker/node_modules/typescript/lib/typescript.js";
import { publicationActionNames } from "../src/bot/publication-actions.js";
import { SCREEN_BUTTONS, type ScreenId } from "../src/bot/screen-callback.js";
import { SCREEN_ROUTES } from "../src/bot/screen-routes.js";

/** Every button in the bot, read out of the source rather than out of a habit.
 *
 * A button is three things that have to agree: the keyboard that emits it, the
 * declaration that says what it carries, and the handler that answers it. When
 * they were only related by a string spelled the same way in three files, they
 * came apart quietly -- a whole archive nobody could open, a period filter
 * nothing emitted, a wizard step nothing entered. This walks the emitters and
 * the tables and refuses each of those shapes. */

const SOURCE_ROOT = join(import.meta.dir, "../src");

type Emission = { id: string; argumentCount: number | null; location: string };

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function eachCall(visit: (node: ts.CallExpression, file: ts.SourceFile, path: string) => void): void {
  for (const path of sourceFiles(SOURCE_ROOT)) {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) visit(node, file, path);
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
}

function where(node: ts.Node, file: ts.SourceFile, path: string): string {
  return `${relative(SOURCE_ROOT, path)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
}

function screenEmissions(): Emission[] {
  const emissions: Emission[] = [];
  eachCall((node, file, path) => {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "screenCallback") return;
    const [idNode, argsNode] = node.arguments;
    // One helper builds the three delivery-preview screens from a view name;
    // its own literals are covered by the emissions inside it.
    if (!idNode || !ts.isStringLiteral(idNode)) return;
    emissions.push({
      id: idNode.text,
      argumentCount: !argsNode ? 0 : ts.isArrayLiteralExpression(argsNode) ? argsNode.elements.length : null,
      location: where(node, file, path),
    });
  });
  return emissions;
}

describe("bot button graph", () => {
  it("emits only declared screens, with the arguments they declare", () => {
    for (const emission of screenEmissions()) {
      expect(SCREEN_BUTTONS, emission.location).toHaveProperty(emission.id);
      const declared = SCREEN_BUTTONS[emission.id as ScreenId]?.args as readonly string[] | undefined;
      if (!declared || emission.argumentCount === null) continue;
      expect(emission.argumentCount, emission.location).toBe(declared.length);
    }
  });

  it("leaves no declared screen without a button that opens it", () => {
    const emitted = new Set(screenEmissions().map((emission) => emission.id));
    // A screen nothing emits is a screen nobody can reach: the analytics
    // archive lived like that for months, and so did a whole video wizard step.
    const unreachable = Object.keys(SCREEN_BUTTONS).filter((id) => !emitted.has(id));
    expect(unreachable).toEqual([]);
  });

  it("routes every declared screen", () => {
    expect(Object.keys(SCREEN_ROUTES).sort()).toEqual(Object.keys(SCREEN_BUTTONS).sort());
  });

  it("builds every button's callback data through a builder, never a literal", () => {
    const literals: string[] = [];
    eachCall((node, file, path) => {
      // `.text(label, data)` is grammY's inline button. Its data must come from
      // screenCallback or publicationCallback -- a string written by hand is how
      // a button ends up pointing at a screen that no longer answers.
      if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "text") return;
      const data = node.arguments[1];
      if (!data) return;
      if (ts.isStringLiteral(data) || ts.isTemplateExpression(data) || ts.isNoSubstitutionTemplateLiteral(data))
        literals.push(`${where(node, file, path)}: ${data.getText(file).slice(0, 40)}`);
    });
    expect(literals).toEqual([]);
  });

  it("names its screen outright, so the graph can see the button", () => {
    const guessed: string[] = [];
    eachCall((node, file, path) => {
      if (!ts.isIdentifier(node.expression) || node.expression.text !== "screenCallback") return;
      const [idNode] = node.arguments;
      if (idNode && !ts.isStringLiteral(idNode)) guessed.push(where(node, file, path));
    });
    expect(guessed).toEqual([]);
  });

  it("keeps a screen button inside Telegram's 64 bytes", () => {
    // Row ids, offsets and pages are numbers; a deployment revision is a Git
    // SHA and gets its own bound in the deployment test.
    const budget = Object.entries(SCREEN_BUTTONS)
      .filter(([id]) => !id.startsWith("deploy_"))
      .map(([id, button]) => id.length + button.args.length * 11);
    expect(Math.max(...budget)).toBeLessThanOrEqual(64);
    expect(publicationActionNames("post").length + publicationActionNames("video").length).toBeGreaterThan(0);
  });
});
