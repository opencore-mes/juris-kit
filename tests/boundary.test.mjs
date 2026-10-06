// The boundary (src/README.md, "The boundary" and "The browser floor"), held by a test: what a
// browser downloads imports nothing it cannot load, nothing in src/ reads the environment, no import
// cycle, and nothing newer than the browser floor in the files a browser runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function filesUnder(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await filesUnder(path)));
        else if (entry.name.endsWith(".js")) out.push(path);
    }
    return out;
}

// The code of a file with its comments and (unless `keepStrings`) string contents blanked, so a rule
// reads code, not prose.
function codeOf(source, { keepStrings = false } = {}) {
    let out = "";
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (c === "/" && next === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
        if (c === "/" && next === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; out += " "; continue; }
        if (c === '"' || c === "'" || c === "`") {
            const quote = c;
            const start = i;
            i++;
            while (i < source.length && source[i] !== quote) { if (source[i] === "\\") i++; i++; }
            i++;
            out += keepStrings ? source.slice(start, i) : quote + quote;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

const importsOf = (text) => [...codeOf(text, { keepStrings: true }).matchAll(/(?:^|[\s;])(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm)].map((m) => m[1] ?? m[2] ?? m[3]);

const top = async () => (await readdir(SRC)).filter((n) => n.endsWith(".js")).map((n) => join(SRC, n));

test("a browser module imports only its flat siblings", async () => {
    for (const file of await top()) {
        const source = await readFile(file, "utf8");
        for (const spec of importsOf(source)) {
            assert.ok(/^\.\/[A-Za-z0-9_-]+\.js$/.test(spec), `${relative(SRC, file)} imports "${spec}": a browser module imports only ./sibling.js`);
        }
        const code = codeOf(source);
        for (const word of ["Buffer", "process", "require("]) {
            assert.ok(!new RegExp(`(^|[^.\\w$])${word.replace("(", "\\(")}`).test(code), `${relative(SRC, file)} uses ${word}`);
        }
    }
});

test("nothing in src/ reads the environment", async () => {
    for (const file of await filesUnder(SRC)) {
        assert.ok(!/process\.env/.test(codeOf(await readFile(file, "utf8"))), `${relative(SRC, file)} reads process.env`);
    }
});

test("no import cycle anywhere in src/", async () => {
    const graph = new Map();
    for (const file of await filesUnder(SRC)) {
        const deps = importsOf(await readFile(file, "utf8")).filter((s) => s.startsWith(".")).map((s) => resolve(dirname(file), s));
        graph.set(file, deps);
    }
    const state = new Map();
    const visit = (file, path) => {
        if (state.get(file) === "done") return;
        assert.notEqual(state.get(file), "open", `import cycle: ${[...path, file].map((f) => relative(SRC, f)).join(" → ")}`);
        state.set(file, "open");
        for (const dep of graph.get(file) ?? []) visit(dep, [...path, file]);
        state.set(file, "done");
    };
    for (const file of graph.keys()) visit(file, []);
});

// Newer than Safari 15.4 / Chrome 93 / Firefox 92: refused in what a browser runs.
const NEWER = [
    [/\.toSorted\(/, "Array.prototype.toSorted"], [/\.toReversed\(/, "Array.prototype.toReversed"], [/\.toSpliced\(/, "Array.prototype.toSpliced"],
    [/\.with\(\s*-?\d/, "Array.prototype.with"], [/\bObject\.groupBy\b/, "Object.groupBy"], [/\bMap\.groupBy\b/, "Map.groupBy"],
    [/\bPromise\.withResolvers\b/, "Promise.withResolvers"], [/\bstructuredClone\(/, "structuredClone"], [/\.findLast(Index)?\(/, "findLast"],
    [/\bcrypto\.randomUUID\(/, "crypto.randomUUID"], [/\bURL\.canParse\b/, "URL.canParse"], [/\bstatic\s*\{/, "class static block"],
    [/\(\?<[=!]/, "regex lookbehind"], [/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, "Set methods"],
    [/\bArray\.fromAsync\b/, "Array.fromAsync"], [/\.hasIndices\b|\/[a-z]*d[a-z]*\.exec/, "regex d flag"],
];
test("the browser floor holds in what a browser runs", async () => {
    for (const file of await top()) {
        const code = codeOf(await readFile(file, "utf8"));
        for (const [pattern, name] of NEWER) assert.ok(!pattern.test(code), `${relative(SRC, file)} uses ${name}, newer than the browser floor`);
    }
});
