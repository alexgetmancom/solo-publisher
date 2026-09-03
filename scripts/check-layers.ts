import fs from "node:fs";
import path from "node:path";
// Keep the graph checker on the stable compiler API while the application can
// move to newer TypeScript releases independently.
import * as ts from "../tools/layer-checker/node_modules/typescript/lib/typescript.js";

const root = path.resolve(import.meta.dirname, "..");
const configPath = path.join(root, ".dependency-cruiser.jsonc");
const sourceRoots = ["apps/backend/src", "apps/web/src", "scripts", "deploy", "shared"];
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage", ".astro"]);
const sourceExtensions = new Set([".ts", ".svelte", ".astro"]);

type RuleSelector = {
  path?: string;
  pathNot?: string;
  dependencyTypes?: string[];
  circular?: boolean;
};

type Rule = {
  name: string;
  severity?: "error" | "warn" | "info";
  from?: RuleSelector;
  to?: RuleSelector;
};

type Edge = {
  source: string;
  target: string;
  specifier: string;
  dependencyType: "local" | "npm";
};

type Config = { forbidden?: Rule[] };

function walk(directory: string, result: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, result);
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) result.push(absolute);
  }
  return result;
}

function relativePath(file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function isSourceFile(file: string): boolean {
  const relative = relativePath(file);
  return sourceRoots.some((directory) => relative === directory || relative.startsWith(`${directory}/`));
}

function stripJsonComments(value: string): string {
  let output = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index] ?? "";
    const next = value[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        output += current;
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else output += current === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      output += current;
    } else if (current === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
    } else if (current === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
    } else output += current;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function readConfig(): Config {
  return JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf8"))) as Config;
}

function selectorMatches(selector: RuleSelector | undefined, value: string, dependencyType: string): boolean {
  if (!selector) return true;
  if (selector.path && !new RegExp(selector.path).test(value)) return false;
  if (selector.pathNot && new RegExp(selector.pathNot).test(value)) return false;
  if (selector.dependencyTypes && !selector.dependencyTypes.includes(dependencyType)) return false;
  return true;
}

function importSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (ts.isStringLiteral(node.moduleReference.expression)) specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function componentImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1] as string);
}

function resolveLocalComponent(specifier: string, file: string): string | null {
  const candidate = path.resolve(path.dirname(file), specifier);
  for (const value of [candidate, ...[".ts", ".svelte", ".astro"].map((extension) => `${candidate}${extension}`)]) {
    if (fs.existsSync(value) && fs.statSync(value).isFile()) return value;
  }
  return null;
}

function resolveEdges(files: string[]): Edge[] {
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: false,
    resolveJsonModule: true,
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: fs.existsSync,
    readFile: (file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
  };
  const edges: Edge[] = [];
  for (const file of files.filter(isSourceFile)) {
    const source = fs.readFileSync(file, "utf8");
    const extension = path.extname(file);
    const specifiers =
      extension === ".ts"
        ? importSpecifiers(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
        : componentImportSpecifiers(source);
    for (const specifier of new Set(specifiers)) {
      const resolved =
        ts.resolveModuleName(specifier, file, compilerOptions, host).resolvedModule?.resolvedFileName ??
        (specifier.startsWith(".") ? resolveLocalComponent(specifier, file) : null);
      if (specifier.startsWith(".") && resolved?.startsWith(root) && fs.existsSync(resolved)) {
        edges.push({ source: relativePath(file), target: relativePath(resolved), specifier, dependencyType: "local" });
      } else if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
        edges.push({ source: relativePath(file), target: `node_modules/${specifier}/`, specifier, dependencyType: "npm" });
      }
    }
  }
  return edges;
}

function cycles(edges: Edge[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.dependencyType !== "local") continue;
    const targets = graph.get(edge.source) ?? [];
    targets.push(edge.target);
    graph.set(edge.source, targets);
  }
  const result: string[][] = [];
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const seen = new Set<string>();
  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const target of graph.get(node) ?? []) {
      if (state.get(target) === "visiting") {
        const start = stack.indexOf(target);
        const cycle = [...stack.slice(start), target];
        const key = cycle.join(" -> ");
        if (!seen.has(key)) {
          seen.add(key);
          result.push(cycle);
        }
      } else if (!state.has(target)) visit(target);
    }
    stack.pop();
    state.set(node, "visited");
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return result;
}

const config = readConfig();
const files = walk(root);
const edges = resolveEdges(files);
const violations: string[] = [];

for (const file of files.filter((value) => relativePath(value).startsWith("apps/web/src/features/story-player/"))) {
  const source = fs.readFileSync(file, "utf8");
  for (const [index, line] of source.split("\n").entries()) {
    if (/(?:#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl)a?\()/.test(line))
      violations.push(`story-player raw colour: ${relativePath(file)}:${index + 1}`);
    if (/z-index:\s*-?\d/.test(line)) violations.push(`story-player raw z-index: ${relativePath(file)}:${index + 1}`);
  }
}

for (const rule of config.forbidden ?? []) {
  if (rule.to?.circular) {
    for (const cycle of cycles(edges)) violations.push(`${rule.name}: ${cycle.join(" -> ")}`);
    continue;
  }
  for (const edge of edges) {
    if (!selectorMatches(rule.from, edge.source, "local")) continue;
    if (!selectorMatches(rule.to, edge.target, edge.dependencyType)) continue;
    violations.push(`${rule.name}: ${edge.source} -> ${edge.target}`);
  }
}

if (violations.length > 0) {
  console.error(`Architecture violations:\n${violations.map((violation) => `- ${violation}`).join("\n")}`);
  process.exit(1);
}

console.log(
  `Layer and Story CSS checks passed: ${new Set(edges.flatMap((edge) => [edge.source, edge.target])).size} modules, ${edges.length} dependencies.`,
);
