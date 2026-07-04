module.exports = [
"[externals]/next/dist/compiled/next-server/app-route-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-route-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/@opentelemetry/api [external] (next/dist/compiled/@opentelemetry/api, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/@opentelemetry/api", () => require("next/dist/compiled/@opentelemetry/api"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/shared/lib/no-fallback-error.external.js [external] (next/dist/shared/lib/no-fallback-error.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/shared/lib/no-fallback-error.external.js", () => require("next/dist/shared/lib/no-fallback-error.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/after-task-async-storage.external.js [external] (next/dist/server/app-render/after-task-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/after-task-async-storage.external.js", () => require("next/dist/server/app-render/after-task-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/node:path [external] (node:path, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:path", () => require("node:path"));

module.exports = mod;
}),
"[project]/src/lib/codeintel/ast-extractor.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "astTsExtractor",
    ()=>astTsExtractor,
    "initTreeSitter",
    ()=>initTreeSitter
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f$web$2d$tree$2d$sitter__$5b$external$5d$__$28$web$2d$tree$2d$sitter$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$web$2d$tree$2d$sitter$29$__ = __turbopack_context__.i("[externals]/web-tree-sitter [external] (web-tree-sitter, cjs, [project]/node_modules/web-tree-sitter)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:path [external] (node:path, cjs)");
;
;
let parser = null;
let tsLanguage = null;
let initAttempted = false;
// WASM lives in <appRoot>/wasm (committed, and traced into the standalone build).
function wasmDir() {
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["resolve"])(process.cwd(), "wasm");
}
async function initTreeSitter() {
    if (initAttempted) return;
    initAttempted = true;
    try {
        await __TURBOPACK__imported__module__$5b$externals$5d2f$web$2d$tree$2d$sitter__$5b$external$5d$__$28$web$2d$tree$2d$sitter$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$web$2d$tree$2d$sitter$29$__["default"].init({
            locateFile: (name)=>(0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["resolve"])(wasmDir(), name)
        });
        const p = new __TURBOPACK__imported__module__$5b$externals$5d2f$web$2d$tree$2d$sitter__$5b$external$5d$__$28$web$2d$tree$2d$sitter$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$web$2d$tree$2d$sitter$29$__["default"]();
        tsLanguage = await __TURBOPACK__imported__module__$5b$externals$5d2f$web$2d$tree$2d$sitter__$5b$external$5d$__$28$web$2d$tree$2d$sitter$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$web$2d$tree$2d$sitter$29$__["default"].Language.load((0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["resolve"])(wasmDir(), "tree-sitter-typescript.wasm"));
        parser = p; // only mark ready once a grammar loaded
    } catch  {
        // WASM unavailable in this environment → extractors fall back to regex.
        parser = null;
        tsLanguage = null;
    }
}
const astTsExtractor = (fallback)=>({
        language: "TypeScript",
        exts: [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mjs",
            ".cjs"
        ],
        extract (text) {
            if (!parser || !tsLanguage) {
                return fallback.extract(text);
            }
            parser.setLanguage(tsLanguage);
            const tree = parser.parse(text);
            const symbols = [];
            const references = new Map();
            // LSP-lite: track EXACT imports so we resolve calls accurately
            // e.g. import { foo as bar } from './baz' -> we know 'bar' maps to 'baz#foo'
            // For now we just collect references to symbols to feed into graph.ts
            // Walk AST
            const cursor = tree.walk();
            const walk = (c)=>{
                const type = c.nodeType;
                // Function / Method declarations
                if (type === "function_declaration" || type === "method_definition" || type === "arrow_function") {
                    const node = c.currentNode;
                    // find name
                    const nameNode = node.childForFieldName("name") || (type === "arrow_function" ? getArrowName(node) : null);
                    if (nameNode) {
                        const isExported = node.parent?.type === "export_statement" || node.parent?.parent?.type === "export_statement";
                        const kind = type === "method_definition" ? "method" : "function";
                        // Find container (class)
                        let container = null;
                        let p = node.parent;
                        while(p){
                            if (p.type === "class_declaration") {
                                container = p.childForFieldName("name")?.text || null;
                                break;
                            }
                            p = p.parent;
                        }
                        symbols.push({
                            name: nameNode.text,
                            kind,
                            line: node.startPosition.row + 1,
                            endLine: node.endPosition.row + 1,
                            signature: node.text.split("\n")[0].slice(0, 100),
                            doc: getDoc(node),
                            exported: isExported,
                            container
                        });
                    }
                }
                // Class declarations
                if (type === "class_declaration" || type === "interface_declaration") {
                    const node = c.currentNode;
                    const nameNode = node.childForFieldName("name");
                    if (nameNode) {
                        const isExported = node.parent?.type === "export_statement";
                        symbols.push({
                            name: nameNode.text,
                            kind: type === "class_declaration" ? "class" : "interface",
                            line: node.startPosition.row + 1,
                            endLine: node.endPosition.row + 1,
                            signature: node.text.split("\n")[0].slice(0, 100),
                            doc: getDoc(node),
                            exported: isExported,
                            container: null
                        });
                    }
                }
                // Call expressions (References)
                if (type === "call_expression") {
                    const node = c.currentNode;
                    const funcNode = node.childForFieldName("function");
                    if (funcNode) {
                        // just grab the identifier
                        let name = funcNode.text;
                        if (funcNode.type === "member_expression") {
                            const prop = funcNode.childForFieldName("property");
                            if (prop) name = prop.text;
                        }
                        references.set(name, (references.get(name) || 0) + 1);
                    }
                }
                if (c.gotoFirstChild()) {
                    do {
                        walk(c);
                    }while (c.gotoNextSibling())
                    c.gotoParent();
                }
            };
            walk(cursor);
            return {
                symbols,
                references
            };
        }
    });
function getArrowName(node) {
    // const foo = () => {}
    const parent = node.parent;
    if (parent && parent.type === "variable_declarator") {
        return parent.childForFieldName("name");
    }
    return null;
}
function getDoc(node) {
    let prev = node.previousSibling;
    if (node.parent?.type === "export_statement") prev = node.parent.previousSibling;
    if (prev && prev.type === "comment") {
        return prev.text.replace(/^\/\*\*?|\*\/$|^\*\s?|^\/\/\s?/g, "").trim().slice(0, 300);
    }
    return null;
}
}),
"[externals]/node:crypto [external] (node:crypto, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:crypto", () => require("node:crypto"));

module.exports = mod;
}),
"[externals]/node:fs [external] (node:fs, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:fs", () => require("node:fs"));

module.exports = mod;
}),
"[project]/src/lib/db.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "db",
    ()=>db
]);
var __TURBOPACK__url__external__node$3a$sqlite__ = __turbopack_context__.x("node:sqlite", ()=>require("node:sqlite"), true);
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:fs [external] (node:fs, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:path [external] (node:path, cjs)");
;
;
;
// Singleton DB across hot-reloads / route invocations.
const g = globalThis;
function init() {
    const dir = process.env.CG_DATA_DIR || __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].join(process.cwd(), "data");
    (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["mkdirSync"])(dir, {
        recursive: true
    });
    const db = new __TURBOPACK__url__external__node$3a$sqlite__["DatabaseSync"](__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].join(dir, "codegraph.sqlite"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'git',
      status TEXT NOT NULL,
      score REAL,
      loc INTEGER DEFAULT 0,
      error TEXT,
      languages TEXT DEFAULT '[]',
      graph TEXT DEFAULT '{}',
      dimensions TEXT DEFAULT '[]',
      deps TEXT DEFAULT '[]',
      issues TEXT DEFAULT '[]',
      viz TEXT DEFAULT '{"nodes":[],"edges":[],"truncated":false}',
      tree TEXT DEFAULT '{}',
      modules TEXT DEFAULT '{"nodes":[],"edges":[]}',
      symbols TEXT DEFAULT '{"symbols":[],"edges":[],"truncated":false,"stats":{"symbols":0,"edges":0,"resolvedCalls":0}}',
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      message TEXT DEFAULT '',
      error TEXT
    );
  `);
    // Migrate older installs: add columns introduced after first release.
    const cols = new Set(db.prepare("PRAGMA table_info(repos)").all().map((c)=>c.name));
    if (!cols.has("source_type")) db.exec("ALTER TABLE repos ADD COLUMN source_type TEXT NOT NULL DEFAULT 'git'");
    if (!cols.has("viz")) db.exec(`ALTER TABLE repos ADD COLUMN viz TEXT DEFAULT '{"nodes":[],"edges":[],"truncated":false}'`);
    if (!cols.has("deps")) db.exec(`ALTER TABLE repos ADD COLUMN deps TEXT DEFAULT '[]'`);
    if (!cols.has("tree")) db.exec(`ALTER TABLE repos ADD COLUMN tree TEXT DEFAULT '{}'`);
    if (!cols.has("modules")) db.exec(`ALTER TABLE repos ADD COLUMN modules TEXT DEFAULT '{"nodes":[],"edges":[]}'`);
    if (!cols.has("symbols")) db.exec(`ALTER TABLE repos ADD COLUMN symbols TEXT DEFAULT '{"symbols":[],"edges":[],"truncated":false,"stats":{"symbols":0,"edges":0,"resolvedCalls":0}}'`);
    return db;
}
function db() {
    if (!g.__cgDb) g.__cgDb = init();
    return g.__cgDb;
}
}),
"[externals]/node:child_process [external] (node:child_process, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:child_process", () => require("node:child_process"));

module.exports = mod;
}),
"[externals]/node:util [external] (node:util, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:util", () => require("node:util"));

module.exports = mod;
}),
"[externals]/node:os [external] (node:os, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:os", () => require("node:os"));

module.exports = mod;
}),
"[project]/src/lib/types.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// Shared types between backend (API routes) and frontend.
__turbopack_context__.s([
    "DIMENSION_META",
    ()=>DIMENSION_META
]);
const DIMENSION_META = {
    correctness: {
        label: "Correctness",
        weight: 0.26,
        color: "#34d399"
    },
    security: {
        label: "Security",
        weight: 0.24,
        color: "#fb7185"
    },
    maintainability: {
        label: "Maintainability",
        weight: 0.22,
        color: "#a78bfa"
    },
    dependency_hygiene: {
        label: "Dependency hygiene",
        weight: 0.16,
        color: "#fbbf24"
    },
    test_integrity: {
        label: "Test integrity",
        weight: 0.12,
        color: "#22d3ee"
    }
};
}),
"[project]/src/lib/codeintel/extractors.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "extractorFor",
    ()=>extractorFor,
    "supportedExts",
    ()=>supportedExts
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$ast$2d$extractor$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/codeintel/ast-extractor.ts [app-route] (ecmascript)");
;
// ---- shared helpers ----
function docAbove(lines, idx, style) {
    const out = [];
    for(let i = idx - 1; i >= 0; i--){
        const l = lines[i].trim();
        if (style === "js") {
            if (l.endsWith("*/") || l.startsWith("*") || l.startsWith("/**") || l.startsWith("//")) {
                out.unshift(l.replace(/^\/\*\*?|\*\/$|^\*\s?|^\/\/\s?/g, "").trim());
                if (l.startsWith("/**")) break;
                continue;
            }
        } else if (l.startsWith("#")) {
            out.unshift(l.replace(/^#\s?/, ""));
            continue;
        }
        break;
    }
    const doc = out.filter(Boolean).join(" ").trim();
    return doc.length > 2 ? doc.slice(0, 300) : null;
}
// Rough block end by brace balance (js-family) starting at a line.
function braceEnd(lines, start) {
    let depth = 0;
    let seen = false;
    for(let i = start; i < lines.length && i < start + 800; i++){
        for (const ch of lines[i]){
            if (ch === "{") {
                depth++;
                seen = true;
            } else if (ch === "}") {
                depth--;
            }
        }
        if (seen && depth <= 0) return i + 1;
    }
    return Math.min(lines.length, start + 1);
}
// Indent-based block end (python).
function indentEnd(lines, start) {
    const base = lines[start].match(/^(\s*)/)[1].length;
    for(let i = start + 1; i < lines.length; i++){
        if (!lines[i].trim()) continue;
        const ind = lines[i].match(/^(\s*)/)[1].length;
        if (ind <= base) return i;
    }
    return lines.length;
}
const REF_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
function collectRefs(text) {
    const m = new Map();
    let r;
    while(r = REF_RE.exec(text)){
        const name = r[1];
        if (name.length < 2) continue;
        m.set(name, (m.get(name) || 0) + 1);
    }
    return m;
}
// ---- TypeScript / JavaScript ----
const JS_KEYWORDS = {
    if: true,
    for: true,
    while: true,
    switch: true,
    catch: true,
    return: true,
    function: true,
    await: true,
    typeof: true,
    super: true,
    new: true,
    in: true,
    of: true
};
const tsExtractor = {
    language: "TypeScript",
    exts: [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs"
    ],
    extract (text) {
        const lines = text.split("\n");
        const symbols = [];
        let classContext = null;
        for(let i = 0; i < lines.length; i++){
            const raw = lines[i];
            const l = raw.trim();
            if (classContext && i + 1 > classContext.endLine) classContext = null;
            const exported = /^export\b/.test(l) || /^export\s+default\b/.test(l);
            // class / interface / type / enum
            let m = l.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class)\s+([A-Za-z0-9_$]+)/) || l.match(/^(?:export\s+)?(interface)\s+([A-Za-z0-9_$]+)/) || l.match(/^(?:export\s+)?(enum)\s+([A-Za-z0-9_$]+)/);
            if (m) {
                const kind = m[1];
                const end = kind === "interface" || kind === "enum" ? braceEnd(lines, i) : braceEnd(lines, i);
                symbols.push({
                    name: m[2],
                    kind,
                    line: i + 1,
                    endLine: end,
                    signature: l.replace(/\s*\{.*$/, ""),
                    doc: docAbove(lines, i, "js"),
                    exported,
                    container: null
                });
                if (kind === "class") classContext = {
                    name: m[2],
                    endLine: end
                };
                continue;
            }
            m = l.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/);
            if (m) {
                symbols.push({
                    name: m[1],
                    kind: "type",
                    line: i + 1,
                    endLine: i + 1,
                    signature: l.replace(/;$/, ""),
                    doc: docAbove(lines, i, "js"),
                    exported,
                    container: null
                });
                continue;
            }
            // function declarations
            m = l.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*(\([^)]*\))/);
            if (m) {
                symbols.push({
                    name: m[1],
                    kind: "function",
                    line: i + 1,
                    endLine: braceEnd(lines, i),
                    signature: `function ${m[1]}${m[2]}`,
                    doc: docAbove(lines, i, "js"),
                    exported,
                    container: null
                });
                continue;
            }
            // const foo = (…) => / arrow & function expr
            m = l.match(/^(?:export\s+)?(?:default\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/) || l.match(/^(?:export\s+)?(?:default\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?function/);
            if (m) {
                const isComponent = /^[A-Z]/.test(m[1]) && (text.includes("react") || text.includes("jsx") || /\.(tsx|jsx)$/.test(""));
                symbols.push({
                    name: m[1],
                    kind: isComponent ? "component" : "function",
                    line: i + 1,
                    endLine: braceEnd(lines, i),
                    signature: l.replace(/\s*=>.*$/, " =>").slice(0, 120),
                    doc: docAbove(lines, i, "js"),
                    exported,
                    container: null
                });
                continue;
            }
            // exported const value
            m = l.match(/^export\s+const\s+([A-Za-z0-9_$]+)\s*[:=]/);
            if (m) {
                symbols.push({
                    name: m[1],
                    kind: "constant",
                    line: i + 1,
                    endLine: i + 1,
                    signature: l.slice(0, 120),
                    doc: docAbove(lines, i, "js"),
                    exported: true,
                    container: null
                });
                continue;
            }
            // class methods
            if (classContext) {
                const mm = raw.match(/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|readonly\s+)*([A-Za-z0-9_$]+)\s*(\([^)]*\))\s*(?::[^={]+)?\{/);
                if (mm && !JS_KEYWORDS[mm[1]]) {
                    symbols.push({
                        name: mm[1],
                        kind: "method",
                        line: i + 1,
                        endLine: braceEnd(lines, i),
                        signature: `${mm[1]}${mm[2]}`,
                        doc: docAbove(lines, i, "js"),
                        exported: classContext ? true : false,
                        container: classContext.name
                    });
                }
            }
        }
        return {
            symbols,
            references: collectRefs(text)
        };
    }
};
// ---- Python ----
const pyExtractor = {
    language: "Python",
    exts: [
        ".py"
    ],
    extract (text) {
        const lines = text.split("\n");
        const symbols = [];
        let classContext = null;
        for(let i = 0; i < lines.length; i++){
            const raw = lines[i];
            const l = raw.trim();
            if (classContext && i >= classContext.endLine) classContext = null;
            let m = l.match(/^class\s+([A-Za-z0-9_]+)/);
            if (m) {
                const end = indentEnd(lines, i);
                symbols.push({
                    name: m[1],
                    kind: "class",
                    line: i + 1,
                    endLine: end,
                    signature: l.replace(/:$/, ""),
                    doc: docAbove(lines, i, "py"),
                    exported: !m[1].startsWith("_"),
                    container: null
                });
                classContext = {
                    name: m[1],
                    endLine: end
                };
                continue;
            }
            m = raw.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*(\([^)]*\))/);
            if (m) {
                const indented = m[1].length > 0;
                symbols.push({
                    name: m[2],
                    kind: indented && classContext ? "method" : "function",
                    line: i + 1,
                    endLine: indentEnd(lines, i),
                    signature: `def ${m[2]}${m[3]}`,
                    doc: docAbove(lines, i, "py"),
                    exported: !m[2].startsWith("_"),
                    container: indented && classContext ? classContext.name : null
                });
            }
        }
        return {
            symbols,
            references: collectRefs(text)
        };
    }
};
// ---- registry ----
const REGISTRY = [
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$ast$2d$extractor$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["astTsExtractor"])(tsExtractor),
    pyExtractor
];
const byExt = new Map();
for (const ex of REGISTRY){
    for (const e of ex.exts){
        // first one wins, so astTsExtractor overrides tsExtractor if registered first
        if (!byExt.has(e)) byExt.set(e, ex);
    }
}
function extractorFor(ext) {
    return byExt.get(ext) ?? null;
}
function supportedExts() {
    return [
        ...byExt.keys()
    ];
}
}),
"[project]/src/lib/codeintel/graph.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "buildSymbolGraph",
    ()=>buildSymbolGraph,
    "symId",
    ()=>symId
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$extractors$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/codeintel/extractors.ts [app-route] (ecmascript)");
;
const MAX_SYMBOLS = 6000;
// Lightweight semantic tagging from name/signature/doc (the "concepts" layer).
const TAG_RULES = [
    {
        tag: "auth",
        re: /\b(auth|login|logout|session|token|jwt|password|credential|oauth|permission)\b/i
    },
    {
        tag: "db",
        re: /\b(db|database|query|sql|repository|model|schema|migration|orm|prisma|sqlite|postgres)\b/i
    },
    {
        tag: "http",
        re: /\b(http|request|response|route|controller|endpoint|api|fetch|axios|handler|middleware)\b/i
    },
    {
        tag: "ui",
        re: /\b(render|component|view|button|modal|page|props|state|hook|css|style)\b/i
    },
    {
        tag: "test",
        re: /\b(test|spec|mock|fixture|assert|expect|describe)\b/i
    },
    {
        tag: "crypto",
        re: /\b(hash|encrypt|decrypt|cipher|sign|verify|crypto|secret)\b/i
    },
    {
        tag: "io",
        re: /\b(read|write|file|stream|buffer|fs|path|serialize|parse|json)\b/i
    },
    {
        tag: "config",
        re: /\b(config|setting|env|option|flag|constant|default)\b/i
    },
    {
        tag: "error",
        re: /\b(error|exception|throw|catch|fail|panic|validate|validation)\b/i
    }
];
function tagsFor(name, signature, doc) {
    const hay = `${name} ${signature} ${doc || ""}`;
    const tags = [];
    for (const { tag, re } of TAG_RULES)if (re.test(hay)) tags.push(tag);
    return tags;
}
const symId = (file, name, line)=>`${file}#${name}@${line}`;
function buildSymbolGraph(files, issuesByFile) {
    const symbols = [];
    const edges = [];
    // name -> symbol ids (for cross-file resolution; multiple defs possible)
    const defsByName = new Map();
    // symbol id -> reference token counts (for pass 2)
    const refsBySymbol = new Map();
    // per-file: list of (symbol, localName) to resolve container + own refs
    const fileRefs = [];
    for (const f of files){
        const ex = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$extractors$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["extractorFor"])(f.ext);
        if (!ex) continue;
        const { symbols: raws, references } = ex.extract(f.text);
        const inFile = [];
        // container name -> id within this file
        const containerId = new Map();
        for (const r of raws){
            if (symbols.length >= MAX_SYMBOLS) break;
            const id = symId(f.rel, r.name, r.line);
            const sym = {
                id,
                name: r.name,
                kind: r.kind,
                file: f.rel,
                line: r.line,
                endLine: r.endLine,
                signature: r.signature,
                doc: r.doc,
                exported: r.exported,
                language: ex.language,
                loc: Math.max(1, r.endLine - r.line + 1),
                container: null,
                fanIn: 0,
                fanOut: 0,
                issues: 0,
                tags: tagsFor(r.name, r.signature, r.doc)
            };
            symbols.push(sym);
            inFile.push(sym);
            if (r.kind === "class" || r.kind === "interface") containerId.set(r.name, id);
            const list = defsByName.get(r.name) || [];
            list.push(id);
            defsByName.set(r.name, list);
            // stash local container name to link after
            sym._container = r.container ?? undefined;
        }
        // CONTAINS edges (class -> method) within file
        for (const sym of inFile){
            const c = sym._container;
            if (c && containerId.has(c)) {
                const cid = containerId.get(c);
                sym.container = cid;
                edges.push({
                    source: cid,
                    target: sym.id,
                    kind: "contains"
                });
            }
            delete sym._container;
        }
        fileRefs.push({
            file: f.rel,
            refs: references,
            symbolsInFile: inFile
        });
    // attribute file-level issue counts to the largest symbol spanning nothing precise: keep on file
    }
    // Attribute issues to symbols by file (coarse: file issue count spread is skipped; store 0, UI uses file issues elsewhere)
    void issuesByFile;
    // Pass 2: resolve references -> CALLS edges.
    // A file's ref tokens resolve to defs (prefer same-file, then exported cross-file).
    let resolvedCalls = 0;
    const seenEdge = new Set();
    for (const fr of fileRefs){
        const localNames = new Map(); // name -> id (defs in this file)
        for (const s of fr.symbolsInFile)localNames.set(s.name, s.id);
        // The "caller" for a ref is the enclosing symbol; approximate by nearest preceding symbol.
        const ordered = [
            ...fr.symbolsInFile
        ].sort((a, b)=>a.line - b.line);
        for (const [name, count] of fr.refs){
            // resolve target
            let targetId = null;
            if (localNames.has(name)) targetId = localNames.get(name);
            else {
                const defs = defsByName.get(name);
                if (defs && defs.length) {
                    // prefer an exported def in another file
                    targetId = defs.find((id)=>id !== undefined) || null;
                }
            }
            if (!targetId) continue;
            const target = symbols.find((s)=>s.id === targetId);
            if (!target) continue;
            // pick caller = last symbol defined before... we don't have ref line; attribute to file's top exported symbol
            // Better: attribute call to every symbol in file whose body could contain it is expensive; use file's primary symbol.
            const caller = ordered.find((s)=>s.id !== targetId && (s.kind === "function" || s.kind === "method" || s.kind === "component")) || ordered[0];
            if (!caller || caller.id === targetId) continue;
            const key = caller.id + "->" + targetId;
            if (seenEdge.has(key)) continue;
            seenEdge.add(key);
            edges.push({
                source: caller.id,
                target: targetId,
                kind: "calls"
            });
            caller.fanOut += 1;
            target.fanIn += Math.min(count, 5);
            resolvedCalls++;
        }
    }
    const truncated = symbols.length >= MAX_SYMBOLS;
    return {
        symbols,
        edges,
        truncated,
        stats: {
            symbols: symbols.length,
            edges: edges.length,
            resolvedCalls
        }
    };
}
;
}),
"[project]/src/lib/indexer.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "cleanup",
    ()=>cleanup,
    "cloneRepo",
    ()=>cloneRepo,
    "indexRepo",
    ()=>indexRepo,
    "resolveLocalDir",
    ()=>resolveLocalDir
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$child_process__$5b$external$5d$__$28$node$3a$child_process$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:child_process [external] (node:child_process, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$util__$5b$external$5d$__$28$node$3a$util$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:util [external] (node:util, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:fs [external] (node:fs, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$os__$5b$external$5d$__$28$node$3a$os$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:os [external] (node:os, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:path [external] (node:path, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$types$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/types.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$graph$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/codeintel/graph.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$extractors$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/codeintel/extractors.ts [app-route] (ecmascript)");
;
;
;
;
;
;
;
;
;
const exec = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$util__$5b$external$5d$__$28$node$3a$util$2c$__cjs$29$__["promisify"])(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$child_process__$5b$external$5d$__$28$node$3a$child_process$2c$__cjs$29$__["execFile"]);
const LANG_BY_EXT = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
    ".rb": "Ruby",
    ".php": "PHP",
    ".c": "C",
    ".h": "C",
    ".cpp": "C++",
    ".hpp": "C++",
    ".cs": "C#",
    ".swift": "Swift",
    ".kt": "Kotlin",
    ".scala": "Scala",
    ".sh": "Shell",
    ".sql": "SQL",
    ".css": "CSS",
    ".scss": "CSS",
    ".html": "HTML",
    ".md": "Markdown",
    ".json": "JSON",
    ".yml": "YAML",
    ".yaml": "YAML"
};
const CODE_EXTS = {
    ".ts": true,
    ".tsx": true,
    ".js": true,
    ".jsx": true,
    ".mjs": true,
    ".cjs": true,
    ".py": true,
    ".go": true,
    ".rs": true,
    ".java": true,
    ".rb": true,
    ".php": true,
    ".c": true,
    ".h": true,
    ".cpp": true,
    ".hpp": true,
    ".cs": true,
    ".swift": true,
    ".kt": true
};
const SKIP_DIRS = {
    ".git": true,
    "node_modules": true,
    "dist": true,
    "build": true,
    ".next": true,
    "out": true,
    "vendor": true,
    "__pycache__": true,
    ".venv": true,
    "venv": true,
    "target": true,
    ".idea": true,
    ".vscode": true,
    "coverage": true
};
const MAX_FILES = Number(process.env.CG_MAX_FILES) || 4000;
const MAX_FILE_BYTES = 400_000;
async function cloneRepo(url) {
    if (!/^https?:\/\/[\w.-]+\/[\w./~-]+/.test(url)) {
        throw new Error("Invalid repository URL. Use a public https git URL.");
    }
    const dir = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["mkdtempSync"])(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].join((0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$os__$5b$external$5d$__$28$node$3a$os$2c$__cjs$29$__["tmpdir"])(), "cg-"));
    await exec("git", [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        url,
        dir
    ], {
        timeout: Number(process.env.CG_CLONE_TIMEOUT_MS) || 90_000,
        maxBuffer: 1024 * 1024 * 16,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0"
        }
    });
    return dir;
}
function resolveLocalDir(inputPath) {
    const resolved = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].resolve(inputPath.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
    if (!(0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["existsSync"])(resolved)) {
        throw new Error(`Path does not exist: ${resolved}`);
    }
    if (!(0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["statSync"])(resolved).isDirectory()) {
        throw new Error(`Not a directory: ${resolved}`);
    }
    return resolved;
}
function walk(root) {
    const out = [];
    const stack = [
        root
    ];
    while(stack.length && out.length < MAX_FILES){
        const cur = stack.pop();
        let entries;
        try {
            entries = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["readdirSync"])(cur);
        } catch  {
            continue;
        }
        for (const name of entries){
            const full = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].join(cur, name);
            let st;
            try {
                st = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["statSync"])(full);
            } catch  {
                continue;
            }
            if (st.isDirectory()) {
                if (!SKIP_DIRS[name] && !name.startsWith(".")) stack.push(full);
            } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
                out.push(full);
            }
        }
    }
    return out;
}
function extractImports(text, ext) {
    const imports = [];
    // Go: `import "pkg/path"` and grouped `import ( "a" \n alias "b" )`.
    if (ext === ".go") {
        const block = /import\s*\(([\s\S]*?)\)/g;
        let bm;
        while(bm = block.exec(text)){
            const sre = /"([^"]+)"/g;
            let sm;
            while(sm = sre.exec(bm[1]))imports.push(sm[1]);
        }
        const single = /import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/g;
        let sm;
        while(sm = single.exec(text))imports.push(sm[1]);
        return imports;
    }
    // Python: `import a.b.c`, `from a.b import c, d`, and relative `from .m import x`.
    if (ext === ".py") {
        for (const rawLine of text.split("\n")){
            const line = rawLine.split("#")[0];
            let m;
            if (m = /^\s*from\s+(\.*[A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(line)) {
                const base = m[1];
                imports.push(base);
                for (const part of m[2].split(",")){
                    const name = part.trim().split(/\s+as\s+/)[0].trim().replace(/[()]/g, "");
                    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                        imports.push(base.endsWith(".") || base === "" ? base + name : base + "." + name);
                    }
                }
            } else if (m = /^\s*import\s+(.+)$/.exec(line)) {
                for (const part of m[1].split(",")){
                    const mod = part.trim().split(/\s+as\s+/)[0].trim();
                    if (mod) imports.push(mod);
                }
            }
        }
        return imports;
    }
    // JS/TS (and other C-family): relative specifiers, resolved against the file dir.
    if (CODE_EXTS[ext]) {
        const re = /(?:import\s+[^'"]*from\s+|require\(\s*|import\s*\(\s*|from\s+)['"]([^'"]+)['"]/g;
        let m;
        while(m = re.exec(text)){
            if (m[1].startsWith(".")) imports.push(m[1]);
        }
    }
    return imports;
}
/** Walk the repo, build per-file records + language stats. */ function scan(root) {
    const paths = walk(root);
    const files = [];
    const langMap = new Map();
    let totalLoc = 0;
    for (const full of paths){
        const ext = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].extname(full).toLowerCase();
        const lang = LANG_BY_EXT[ext];
        if (!lang) continue;
        let text = "";
        try {
            text = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["readFileSync"])(full, "utf8");
        } catch  {
            continue;
        }
        const loc = text.length ? text.split("\n").length : 0;
        totalLoc += loc;
        const cur = langMap.get(lang) || {
            files: 0,
            loc: 0
        };
        cur.files += 1;
        cur.loc += loc;
        langMap.set(lang, cur);
        files.push({
            rel: __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].relative(root, full),
            ext,
            loc,
            text: CODE_EXTS[ext] ? text : "",
            imports: extractImports(text, ext)
        });
    }
    const languages = [
        ...langMap.entries()
    ].map(([language, v])=>({
            language,
            ...v
        })).sort((a, b)=>b.loc - a.loc);
    return {
        files,
        languages,
        loc: totalLoc
    };
}
function computeImportGraph(files) {
    const toPosix = (r)=>r.split(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].sep).join("/");
    const byNoExt = new Map(); // JS/TS: path (with/without ext) -> rel
    const goDirs = new Map(); // Go: repo dir -> .go files in it
    const pyByDotted = new Map(); // Python: dotted module -> rel
    for (const f of files){
        const rel = toPosix(f.rel);
        const noExt = rel.replace(/\.[^./]+$/, "");
        byNoExt.set(noExt, f.rel);
        byNoExt.set(rel, f.rel);
        if (f.ext === ".go") {
            const dir = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.dirname(rel);
            (goDirs.get(dir) ?? goDirs.set(dir, []).get(dir)).push(f.rel);
        } else if (f.ext === ".py") {
            if (__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.basename(noExt) === "__init__") {
                const pkg = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.dirname(rel).split("/").filter(Boolean).join(".");
                if (pkg) pyByDotted.set(pkg, f.rel);
            } else {
                pyByDotted.set(noExt.split("/").filter(Boolean).join("."), f.rel);
            }
        }
    }
    const fanIn = new Map();
    const importEdges = [];
    const link = (from, to)=>{
        if (to && to !== from) {
            fanIn.set(to, (fanIn.get(to) || 0) + 1);
            importEdges.push({
                from,
                to
            });
        }
    };
    for (const f of files){
        const rel = toPosix(f.rel);
        const dir = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.dirname(rel);
        for (const imp of f.imports){
            if (f.ext === ".go") {
                // Local Go imports share the repo's module prefix; match the longest
                // trailing path segment run against an actual repo directory.
                const segs = imp.split("/").filter(Boolean);
                for(let k = Math.min(segs.length, 8); k >= 1; k--){
                    const suffix = segs.slice(segs.length - k).join("/");
                    const pkgFiles = goDirs.get(suffix);
                    if (pkgFiles && suffix !== dir) {
                        for (const target of pkgFiles)link(f.rel, target);
                        break;
                    }
                }
            } else if (f.ext === ".py") {
                let target;
                if (imp.startsWith(".")) {
                    const m = /^(\.+)(.*)$/.exec(imp);
                    const baseParts = dir.split("/").filter(Boolean);
                    const upParts = baseParts.slice(0, Math.max(0, baseParts.length - (m[1].length - 1)));
                    const full = [
                        ...upParts,
                        ...m[2].split(".").filter(Boolean)
                    ].join(".");
                    target = pyByDotted.get(full);
                } else {
                    target = pyByDotted.get(imp);
                }
                if (target) link(f.rel, target);
            } else {
                // JS/TS relative import.
                const t = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.normalize(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.join(dir, imp)).replace(/^\.\//, "");
                const cand = byNoExt.get(t) || byNoExt.get(t + "/index") || byNoExt.get(t.replace(/\/$/, ""));
                if (cand) link(f.rel, cand);
            }
        }
    }
    return {
        fanIn,
        importEdges
    };
}
let issueSeq = 0;
function mkIssue(dimension, severity, title, file, line, blastRadius) {
    return {
        id: `i${issueSeq++}`,
        dimension,
        severity,
        title,
        file,
        line,
        blastRadius
    };
}
// Heuristic, language-agnostic-ish defect/risk rules.
const RULES = [
    {
        re: /\beval\s*\(/,
        dimension: "security",
        severity: 5,
        title: "Use of eval()"
    },
    {
        re: /child_process|os\.system\(|subprocess\.(call|run|Popen)\(/,
        dimension: "security",
        severity: 3,
        title: "Shell/process execution"
    },
    {
        re: /(password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{6,}['"]/i,
        dimension: "security",
        severity: 5,
        title: "Possible hardcoded secret"
    },
    {
        re: /https?:\/\/[^"'\s]*(?<![\w.])(localhost|127\.0\.0\.1)/,
        dimension: "security",
        severity: 2,
        title: "Hardcoded local URL"
    },
    {
        re: /\bdangerouslySetInnerHTML\b|innerHTML\s*=/,
        dimension: "security",
        severity: 3,
        title: "Raw HTML injection sink"
    },
    {
        re: /SELECT\s+.+\+|query\(\s*['"`].*\$\{/i,
        dimension: "security",
        severity: 4,
        title: "Possible SQL string concatenation"
    },
    {
        re: /\bconsole\.(log|debug)\b|^\s*print\(/m,
        dimension: "correctness",
        severity: 1,
        title: "Leftover debug output"
    },
    {
        re: /\bdebugger\b/,
        dimension: "correctness",
        severity: 2,
        title: "debugger statement"
    },
    {
        re: /catch\s*\([^)]*\)\s*\{\s*\}/,
        dimension: "correctness",
        severity: 3,
        title: "Empty catch block"
    },
    {
        re: /\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/,
        dimension: "maintainability",
        severity: 1,
        title: "TODO/FIXME marker"
    },
    {
        re: /@ts-(ignore|nocheck)|# type: ignore|eslint-disable/,
        dimension: "maintainability",
        severity: 2,
        title: "Suppressed checker"
    },
    {
        re: /:\s*any\b|\bas\s+any\b/,
        dimension: "correctness",
        severity: 1,
        title: "Untyped `any`",
        exts: {
            ".ts": true,
            ".tsx": true
        }
    }
];
function analyzeFiles(files, fanIn) {
    const issues = [];
    for (const f of files){
        if (!f.text) continue;
        const br = 1 + (fanIn.get(f.rel) || 0); // blast radius from graph fan-in
        const lines = f.text.split("\n");
        for (const rule of RULES){
            if (rule.exts && !rule.exts[f.ext]) continue;
            for(let i = 0; i < lines.length; i++){
                if (rule.re.test(lines[i])) {
                    issues.push(mkIssue(rule.dimension, rule.severity, rule.title, f.rel, i + 1, br));
                    break; // one hit per rule per file keeps signal clean
                }
            }
        }
        // God-file: very large source file → maintainability penalty scaled by fan-in.
        if (f.loc > 600) {
            issues.push(mkIssue("maintainability", f.loc > 1200 ? 4 : 2, `Large file (${f.loc} LOC)`, f.rel, 1, br));
        }
    }
    return issues;
}
/** Dependency hygiene from manifests actually present in the repo. */ function analyzeDependencies(root) {
    const depsList = [];
    const issues = [];
    let count = 0;
    const pkgPath = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].join(root, "package.json");
    if ((0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["existsSync"])(pkgPath)) {
        try {
            const pkg = JSON.parse((0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["readFileSync"])(pkgPath, "utf8"));
            const deps = {
                ...pkg.dependencies || {},
                ...pkg.devDependencies || {}
            };
            count = Object.keys(deps).length;
            depsList.push(...Object.keys(deps));
            for (const [name, range] of Object.entries(deps)){
                const v = String(range);
                if (v === "*" || v === "latest" || v.startsWith("http") || v.startsWith("git")) {
                    issues.push(mkIssue("dependency_hygiene", 3, `Unpinned dependency: ${name} (${v})`, "package.json", 1, 2));
                } else if (/^[~^]?0\./.test(v)) {
                    issues.push(mkIssue("dependency_hygiene", 1, `Pre-1.0 dependency: ${name} (${v})`, "package.json", 1, 1));
                }
            }
            if (!(0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["existsSync"])(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].join(root, "package-lock.json")) && !(0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["existsSync"])(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].join(root, "pnpm-lock.yaml")) && !(0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["existsSync"])(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].join(root, "yarn.lock"))) {
                issues.push(mkIssue("dependency_hygiene", 2, "No lockfile committed", "package.json", 1, 2));
            }
        } catch  {
        /* ignore malformed */ }
    }
    const reqPath = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].join(root, "requirements.txt");
    if ((0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["existsSync"])(reqPath)) {
        try {
            const lines = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["readFileSync"])(reqPath, "utf8").split("\n").filter((l)=>l.trim() && !l.startsWith("#"));
            count += lines.length;
            for (const l of lines){
                const m = l.match(/^([A-Za-z0-9_-]+)/);
                if (m) depsList.push(m[1]);
                if (!/[=<>~]/.test(l)) {
                    issues.push(mkIssue("dependency_hygiene", 2, `Unpinned dependency: ${l.trim()}`, "requirements.txt", 1, 1));
                }
            }
        } catch  {
        /* ignore */ }
    }
    return {
        issues,
        count,
        depsList
    };
}
/** Test integrity: presence/ratio of test files. */ function analyzeTests(files) {
    const code = files.filter((f)=>CODE_EXTS[f.ext]);
    if (code.length === 0) return [];
    const tests = code.filter((f)=>/(\.|_|\/)(test|spec)/i.test(f.rel) || /(^|\/)tests?\//i.test(f.rel));
    const ratio = tests.length / code.length;
    const issues = [];
    if (tests.length === 0) {
        issues.push(mkIssue("test_integrity", 4, "No test files detected", ".", 1, 3));
    } else if (ratio < 0.1) {
        issues.push(mkIssue("test_integrity", 2, `Low test coverage ratio (${(ratio * 100).toFixed(0)}% of code files)`, ".", 1, 2));
    }
    return issues;
}
/**
 * Score model (per design doc 07):
 *   penalty = Σ severity × blastRadius   (recency/confidence = 1 here)
 *   sub_score = 100 × exp(-k · penalty / sizeFactor)
 * Larger codebases tolerate more raw penalty (normalized by LOC).
 */ function score(issues, loc, depCount) {
    const sizeFactor = Math.max(1, Math.log10(Math.max(loc, 10)) ** 2); // ~1 small → ~10 huge
    const k = 0.06;
    const dims = Object.keys(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$types$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["DIMENSION_META"]).map((dim)=>{
        const di = issues.filter((i)=>i.dimension === dim);
        const penalty = di.reduce((s, i)=>s + i.severity * i.blastRadius, 0);
        const norm = penalty / sizeFactor;
        const sub = 100 * Math.exp(-k * norm);
        return {
            dimension: dim,
            score: Math.round(Math.max(0, Math.min(100, sub))),
            penalty: Math.round(penalty * 10) / 10,
            issueCount: di.length
        };
    });
    const overall = dims.reduce((s, d)=>s + d.score * __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$types$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["DIMENSION_META"][d.dimension].weight, 0);
    return {
        dimensions: dims,
        overall: Math.round(overall)
    };
}
const VIZ_NODE_CAP = 350;
/** Build the renderable node/edge graph (files + dirs + import/containment edges). */ function buildVizGraph(files, importEdges, fanIn, issues) {
    // Per-file issue aggregation.
    const issueCount = new Map();
    const worstSev = new Map();
    for (const i of issues){
        issueCount.set(i.file, (issueCount.get(i.file) || 0) + 1);
        worstSev.set(i.file, Math.max(worstSev.get(i.file) || 0, i.severity));
    }
    // Choose which files to render; keep highest-impact when over the cap.
    let chosen = files;
    let truncated = false;
    if (files.length > VIZ_NODE_CAP) {
        chosen = [
            ...files
        ].sort((a, b)=>(fanIn.get(b.rel) || 0) * 3 + b.loc / 100 - ((fanIn.get(a.rel) || 0) * 3 + a.loc / 100)).slice(0, VIZ_NODE_CAP);
        truncated = true;
    }
    const included = new Set(chosen.map((f)=>f.rel));
    const nodes = new Map();
    const edges = [];
    const toPosix = (p)=>p.split(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].sep).join("/");
    function ensureDir(dir) {
        const id = dir === "" || dir === "." ? "." : dir;
        if (!nodes.has(id)) {
            nodes.set(id, {
                id,
                label: id === "." ? "/" : __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.basename(id),
                kind: "dir",
                language: null,
                loc: 0,
                fanIn: 0,
                issues: 0,
                worstSeverity: 0
            });
        }
        return id;
    }
    // Build the directory chain and containment edges up to root.
    function linkChain(relFile) {
        const posix = toPosix(relFile);
        let dir = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.dirname(posix);
        let child = posix;
        // file's immediate dir -> ... -> root
        while(true){
            const dirId = ensureDir(dir);
            edges.push({
                source: dirId,
                target: child,
                kind: "contains"
            });
            if (dir === "." || dir === "") break;
            child = dirId;
            dir = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.dirname(dir);
        }
    }
    for (const f of chosen){
        const posix = toPosix(f.rel);
        nodes.set(posix, {
            id: posix,
            label: __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.basename(posix),
            kind: "file",
            language: LANG_BY_EXT[f.ext] || null,
            loc: f.loc,
            fanIn: fanIn.get(f.rel) || 0,
            issues: issueCount.get(f.rel) || 0,
            worstSeverity: worstSev.get(f.rel) || 0
        });
        linkChain(f.rel);
    }
    for (const e of importEdges){
        if (included.has(e.from) && included.has(e.to)) {
            edges.push({
                source: toPosix(e.from),
                target: toPosix(e.to),
                kind: "imports"
            });
        }
    }
    return {
        nodes: [
            ...nodes.values()
        ],
        edges,
        truncated
    };
}
/** Build the nested file tree for circle-packing (all files, not capped). */ function buildTree(files, issuesByFile) {
    const root = {
        name: "/",
        path: ".",
        children: []
    };
    const dirCache = new Map([
        [
            ".",
            root
        ]
    ]);
    function ensureDir(dirPosix) {
        if (dirCache.has(dirPosix)) return dirCache.get(dirPosix);
        const parentPath = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.dirname(dirPosix);
        const parent = parentPath === dirPosix ? root : ensureDir(parentPath === "" ? "." : parentPath);
        const node = {
            name: __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.basename(dirPosix),
            path: dirPosix,
            children: []
        };
        parent.children.push(node);
        dirCache.set(dirPosix, node);
        return node;
    }
    for (const f of files){
        const posix = f.rel.split(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].sep).join("/");
        const dirPosix = __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.dirname(posix);
        const parent = dirPosix === "." || dirPosix === "" ? root : ensureDir(dirPosix);
        parent.children.push({
            name: __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.basename(posix),
            path: posix,
            ext: f.ext,
            loc: Math.max(1, f.loc),
            issues: issuesByFile.get(f.rel) || 0
        });
    }
    return root;
}
/** Aggregate files into top-level modules + inter-module import edges (flowchart). */ function buildModuleGraph(files, importEdges, issuesByFile) {
    // Count files per top-level dir; big top dirs get expanded to 2 levels so the
    // architecture graph stays meaningful instead of a few giant blobs.
    const topCount = new Map();
    for (const f of files){
        const seg = f.rel.split(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].sep).join("/").split("/");
        const top = seg.length > 1 ? seg[0] : "(root)";
        topCount.set(top, (topCount.get(top) || 0) + 1);
    }
    const EXPAND_THRESHOLD = 12;
    const moduleOf = (rel)=>{
        const seg = rel.split(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].sep).join("/").split("/");
        if (seg.length <= 1) return "(root)";
        const top = seg[0];
        if (seg.length >= 3 && (topCount.get(top) || 0) > EXPAND_THRESHOLD) {
            return top + "/" + seg[1];
        }
        return top;
    };
    const mods = new Map();
    const langCount = new Map();
    for (const f of files){
        const id = moduleOf(f.rel);
        let m = mods.get(id);
        if (!m) {
            m = {
                id,
                label: id,
                files: 0,
                loc: 0,
                issues: 0,
                language: null,
                tier: 0
            };
            mods.set(id, m);
            langCount.set(id, new Map());
        }
        m.files += 1;
        m.loc += f.loc;
        m.issues += issuesByFile.get(f.rel) || 0;
        const lang = LANG_BY_EXT[f.ext];
        if (lang) {
            const lc = langCount.get(id);
            lc.set(lang, (lc.get(lang) || 0) + 1);
        }
    }
    for (const [id, m] of mods){
        const lc = langCount.get(id);
        let best = null;
        let bestN = 0;
        for (const [lang, n] of lc)if (n > bestN) {
            bestN = n;
            best = lang;
        }
        m.language = best;
    }
    const edgeW = new Map();
    for (const e of importEdges){
        const s = moduleOf(e.from);
        const t = moduleOf(e.to);
        if (s === t) continue;
        const key = s + "→" + t;
        const ex = edgeW.get(key);
        if (ex) ex.weight += 1;
        else edgeW.set(key, {
            source: s,
            target: t,
            weight: 1
        });
    }
    const edges = [
        ...edgeW.values()
    ];
    // Assign tiers by longest-path depth (cycles broken by visited guard).
    const adj = new Map();
    for (const m of mods.keys())adj.set(m, []);
    for (const e of edges)adj.get(e.source)?.push(e.target);
    const tierOf = new Map();
    function depth(node, seen) {
        if (tierOf.has(node)) return tierOf.get(node);
        if (seen.has(node)) return 0;
        seen.add(node);
        let d = 0;
        for (const next of adj.get(node) || [])d = Math.max(d, 1 + depth(next, seen));
        seen.delete(node);
        tierOf.set(node, d);
        return d;
    }
    for (const m of mods.keys())m && (mods.get(m).tier = depth(m, new Set()));
    return {
        nodes: [
            ...mods.values()
        ].sort((a, b)=>a.tier - b.tier || b.loc - a.loc),
        edges
    };
}
function indexRepo(root) {
    issueSeq = 0;
    const { files, languages, loc } = scan(root);
    const { fanIn, importEdges } = computeImportGraph(files);
    const codeIssues = analyzeFiles(files, fanIn);
    const dep = analyzeDependencies(root);
    const testIssues = analyzeTests(files);
    const issues = [
        ...codeIssues,
        ...dep.issues,
        ...testIssues
    ];
    const dirCount = new Set(files.map((f)=>__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].posix.dirname(f.rel.split(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].sep).join("/")))).size;
    const graphStats = {
        files: files.length,
        dirs: dirCount,
        dependencies: dep.count,
        nodes: files.length + dirCount + dep.count,
        edges: importEdges.length + files.length
    };
    const { dimensions, overall } = score(issues, loc, dep.count);
    issues.sort((a, b)=>b.severity * b.blastRadius - a.severity * a.blastRadius);
    // Per-file issue counts (shared by viz, tree, modules).
    const issuesByFile = new Map();
    for (const i of issues)issuesByFile.set(i.file, (issuesByFile.get(i.file) || 0) + 1);
    const viz = buildVizGraph(files, importEdges, fanIn, issues);
    const tree = buildTree(files, issuesByFile);
    const modules = buildModuleGraph(files, importEdges, issuesByFile);
    // Symbol-level knowledge graph (code intelligence layer).
    const symbolGraph = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$graph$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["buildSymbolGraph"])(files.filter((f)=>f.text && (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$extractors$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["extractorFor"])(f.ext)).map((f)=>({
            rel: f.rel.split(__TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].sep).join("/"),
            ext: f.ext,
            text: f.text,
            language: LANG_BY_EXT[f.ext] || "unknown"
        })), issuesByFile);
    return {
        loc,
        languages,
        graph: graphStats,
        dimensions,
        issues: issues.slice(0, 200),
        dependencies: dep.depsList,
        score: overall,
        viz,
        tree,
        modules,
        symbolGraph
    };
}
function cleanup(dir) {
    try {
        (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$fs__$5b$external$5d$__$28$node$3a$fs$2c$__cjs$29$__["rmSync"])(dir, {
            recursive: true,
            force: true
        });
    } catch  {
    /* best effort */ }
}
}),
"[project]/src/lib/store.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "createIndexJob",
    ()=>createIndexJob,
    "deleteRepo",
    ()=>deleteRepo,
    "getJob",
    ()=>getJob,
    "getRepo",
    ()=>getRepo,
    "listRepos",
    ()=>listRepos
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$ast$2d$extractor$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/codeintel/ast-extractor.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$crypto__$5b$external$5d$__$28$node$3a$crypto$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:crypto [external] (node:crypto, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:path [external] (node:path, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$indexer$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/indexer.ts [app-route] (ecmascript)");
;
;
;
;
;
const EMPTY_VIZ = {
    nodes: [],
    edges: [],
    truncated: false
};
function gitName(url) {
    const m = url.replace(/\.git$/, "").match(/([^/]+\/[^/]+)\/?$/);
    return m ? m[1] : url;
}
function createIndexJob(source, sourceType) {
    const repoId = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$crypto__$5b$external$5d$__$28$node$3a$crypto$2c$__cjs$29$__["randomUUID"])();
    const jobId = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$crypto__$5b$external$5d$__$28$node$3a$crypto$2c$__cjs$29$__["randomUUID"])();
    const now = Date.now();
    const name = sourceType === "git" ? gitName(source) : __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$path__$5b$external$5d$__$28$node$3a$path$2c$__cjs$29$__["default"].basename(source.replace(/\/+$/, "")) || source;
    const d = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"])();
    d.prepare("INSERT INTO repos (id, url, name, source_type, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)").run(repoId, source, name, sourceType, now);
    d.prepare("INSERT INTO jobs (id, repo_id, status, progress, message) VALUES (?, ?, 'queued', 0, 'Queued')").run(jobId, repoId);
    // Fire-and-forget: runs in the Node server process.
    void runJob(jobId, repoId, source, sourceType);
    return {
        jobId,
        repoId
    };
}
function setJob(jobId, status, progress, message, error) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"])().prepare("UPDATE jobs SET status=?, progress=?, message=?, error=? WHERE id=?").run(status, progress, message, error ?? null, jobId);
}
function setRepoStatus(repoId, status) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"])().prepare("UPDATE repos SET status=? WHERE id=?").run(status, repoId);
}
async function runJob(jobId, repoId, source, sourceType) {
    let tempDir = null;
    try {
        let root;
        if (sourceType === "git") {
            setJob(jobId, "cloning", 15, "Cloning repository…");
            setRepoStatus(repoId, "cloning");
            root = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$indexer$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["cloneRepo"])(source);
            tempDir = root; // clean up clones only
        } else {
            setJob(jobId, "cloning", 15, "Reading local folder…");
            setRepoStatus(repoId, "cloning");
            root = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$indexer$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["resolveLocalDir"])(source);
        }
        setJob(jobId, "indexing", 30, "Initializing Tree-sitter parsers…");
        await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$codeintel$2f$ast$2d$extractor$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["initTreeSitter"])();
        setJob(jobId, "indexing", 55, "Building knowledge graph…");
        setRepoStatus(repoId, "indexing");
        const result = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$indexer$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["indexRepo"])(root);
        setJob(jobId, "scoring", 85, "Computing Health Score…");
        setRepoStatus(repoId, "scoring");
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"])().prepare(`UPDATE repos SET status='done', score=?, loc=?, languages=?, graph=?, dimensions=?, issues=?, deps=?, viz=?, tree=?, modules=?, symbols=?, finished_at=?
         WHERE id=?`).run(result.score, result.loc, JSON.stringify(result.languages), JSON.stringify(result.graph), JSON.stringify(result.dimensions), JSON.stringify(result.issues), JSON.stringify(result.dependencies), JSON.stringify(result.viz), JSON.stringify(result.tree), JSON.stringify(result.modules), JSON.stringify(result.symbolGraph), Date.now(), repoId);
        setJob(jobId, "done", 100, `Done — Health Score ${result.score}/100`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setJob(jobId, "error", 100, "Indexing failed", msg);
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"])().prepare("UPDATE repos SET status='error', error=?, finished_at=? WHERE id=?").run(msg, Date.now(), repoId);
    } finally{
        if (tempDir) (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$indexer$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["cleanup"])(tempDir);
    }
}
function getJob(jobId) {
    const r = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"])().prepare("SELECT id, repo_id, status, progress, message, error FROM jobs WHERE id=?").get(jobId);
    if (!r) return null;
    return {
        id: r.id,
        repoId: r.repo_id,
        status: r.status,
        progress: r.progress,
        message: r.message,
        error: r.error
    };
}
function listRepos() {
    const rows = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"])().prepare("SELECT id, url, name, source_type, status, score, created_at, finished_at FROM repos ORDER BY created_at DESC LIMIT 100").all();
    return rows.map((r)=>({
            id: r.id,
            url: r.url,
            name: r.name,
            sourceType: r.source_type || "git",
            status: r.status,
            score: r.score ?? null,
            createdAt: r.created_at,
            finishedAt: r.finished_at ?? null
        }));
}
function deleteRepo(id) {
    const d = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"])();
    d.prepare("DELETE FROM jobs WHERE repo_id = ?").run(id);
    const res = d.prepare("DELETE FROM repos WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
}
function getRepo(id) {
    const r = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"])().prepare("SELECT * FROM repos WHERE id=?").get(id);
    if (!r) return null;
    return {
        id: r.id,
        url: r.url,
        name: r.name,
        sourceType: r.source_type || "git",
        status: r.status,
        score: r.score ?? null,
        error: r.error ?? null,
        loc: r.loc ?? 0,
        languages: JSON.parse(r.languages || "[]"),
        graph: JSON.parse(r.graph || "{}"),
        dimensions: JSON.parse(r.dimensions || "[]"),
        issues: JSON.parse(r.issues || "[]"),
        dependencies: JSON.parse(r.deps || "[]"),
        viz: JSON.parse(r.viz || "null") || EMPTY_VIZ,
        tree: JSON.parse(r.tree || "null") || {
            name: "/",
            path: ".",
            children: []
        },
        modules: JSON.parse(r.modules || "null") || {
            nodes: [],
            edges: []
        },
        symbolGraph: JSON.parse(r.symbols || "null") || {
            symbols: [],
            edges: [],
            truncated: false,
            stats: {
                symbols: 0,
                edges: 0,
                resolvedCalls: 0
            }
        },
        createdAt: r.created_at,
        finishedAt: r.finished_at ?? null
    };
}
}),
"[project]/src/app/api/repos/route.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "GET",
    ()=>GET,
    "dynamic",
    ()=>dynamic,
    "runtime",
    ()=>runtime
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/server.js [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/store.ts [app-route] (ecmascript)");
;
;
const runtime = "nodejs";
const dynamic = "force-dynamic";
async function GET() {
    return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
        repos: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["listRepos"])()
    });
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__0ass143._.js.map