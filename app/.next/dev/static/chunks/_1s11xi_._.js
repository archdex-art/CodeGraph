(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/components/NodeGraph.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "NodeGraph",
    ()=>NodeGraph
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
function borderPoint(n, towardX, towardY) {
    const dx = towardX - n.x;
    const dy = towardY - n.y;
    const adx = Math.abs(dx) || 1e-6;
    const ady = Math.abs(dy) || 1e-6;
    const t = Math.min(n.w / 2 / adx, n.h / 2 / ady);
    return {
        x: n.x + dx * t,
        y: n.y + dy * t
    };
}
function edgePath(s, t) {
    const start = borderPoint(s, t.x, t.y);
    const end = borderPoint(t, s.x, s.y);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    let c1x, c1y, c2x, c2y;
    if (Math.abs(dy) >= Math.abs(dx)) {
        c1x = start.x;
        c1y = start.y + dy * 0.5;
        c2x = end.x;
        c2y = end.y - dy * 0.5;
    } else {
        c1x = start.x + dx * 0.5;
        c1y = start.y;
        c2x = end.x - dx * 0.5;
        c2y = end.y;
    }
    return {
        d: `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`,
        end
    };
}
function NodeGraph({ nodes, edges, height = 600, onSelect }) {
    _s();
    const wrapRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const [vp, setVp] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({
        w: 900,
        h: height
    });
    const [view, setView] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({
        scale: 1,
        ox: 0,
        oy: 0
    });
    const [hoverId, setHoverId] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [selId, setSelId] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const drag = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])({
        on: false,
        lx: 0,
        ly: 0,
        moved: false
    });
    const nodeMap = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "NodeGraph.useMemo[nodeMap]": ()=>new Map(nodes.map({
                "NodeGraph.useMemo[nodeMap]": (n)=>[
                        n.id,
                        n
                    ]
            }["NodeGraph.useMemo[nodeMap]"]))
    }["NodeGraph.useMemo[nodeMap]"], [
        nodes
    ]);
    // Adjacency for hover highlight.
    const adj = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "NodeGraph.useMemo[adj]": ()=>{
            const m = new Map();
            for (const n of nodes)m.set(n.id, new Set());
            for (const e of edges){
                m.get(e.source)?.add(e.target);
                m.get(e.target)?.add(e.source);
            }
            return m;
        }
    }["NodeGraph.useMemo[adj]"], [
        nodes,
        edges
    ]);
    const bounds = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "NodeGraph.useMemo[bounds]": ()=>{
            if (!nodes.length) return {
                minX: 0,
                minY: 0,
                maxX: 1,
                maxY: 1
            };
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const n of nodes){
                minX = Math.min(minX, n.x - n.w / 2);
                maxX = Math.max(maxX, n.x + n.w / 2);
                minY = Math.min(minY, n.y - n.h / 2);
                maxY = Math.max(maxY, n.y + n.h / 2);
            }
            return {
                minX,
                minY,
                maxX,
                maxY
            };
        }
    }["NodeGraph.useMemo[bounds]"], [
        nodes
    ]);
    const fit = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "NodeGraph.useMemo[fit]": ()=>({
                "NodeGraph.useMemo[fit]": ()=>{
                    const pad = 40;
                    const spanX = Math.max(1, bounds.maxX - bounds.minX);
                    const spanY = Math.max(1, bounds.maxY - bounds.minY);
                    const scale = Math.max(0.15, Math.min(2.2, Math.min((vp.w - pad * 2) / spanX, (vp.h - pad * 2) / spanY)));
                    setView({
                        scale,
                        ox: vp.w / 2 - (bounds.minX + bounds.maxX) / 2 * scale,
                        oy: vp.h / 2 - (bounds.minY + bounds.maxY) / 2 * scale
                    });
                }
            })["NodeGraph.useMemo[fit]"]
    }["NodeGraph.useMemo[fit]"], [
        bounds,
        vp
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "NodeGraph.useEffect": ()=>{
            const wrap = wrapRef.current;
            if (!wrap) return;
            const ro = new ResizeObserver({
                "NodeGraph.useEffect": ()=>setVp({
                        w: wrap.clientWidth,
                        h: wrap.clientHeight || height
                    })
            }["NodeGraph.useEffect"]);
            ro.observe(wrap);
            setVp({
                w: wrap.clientWidth,
                h: wrap.clientHeight || height
            });
            return ({
                "NodeGraph.useEffect": ()=>ro.disconnect()
            })["NodeGraph.useEffect"];
        }
    }["NodeGraph.useEffect"], [
        height
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "NodeGraph.useEffect": ()=>{
            fit();
        // eslint-disable-next-line react-hooks/exhaustive-deps
        }
    }["NodeGraph.useEffect"], [
        bounds,
        vp.w,
        vp.h
    ]);
    const active = hoverId ?? selId;
    const activeNeighbors = active ? adj.get(active) : null;
    const isDim = (id)=>active != null && id !== active && !activeNeighbors?.has(id);
    const edgeActive = (e)=>active != null && (e.source === active || e.target === active);
    function onWheel(e) {
        e.preventDefault();
        const rect = wrapRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        setView((v)=>{
            const scale = Math.max(0.1, Math.min(4, v.scale * f));
            const wx = (mx - v.ox) / v.scale;
            const wy = (my - v.oy) / v.scale;
            return {
                scale,
                ox: mx - wx * scale,
                oy: my - wy * scale
            };
        });
    }
    function zoomBy(factor) {
        setView((v)=>{
            const scale = Math.max(0.1, Math.min(4, v.scale * factor));
            const cx = vp.w / 2;
            const cy = vp.h / 2;
            const wx = (cx - v.ox) / v.scale;
            const wy = (cy - v.oy) / v.scale;
            return {
                scale,
                ox: cx - wx * scale,
                oy: cy - wy * scale
            };
        });
    }
    function onDown(e) {
        drag.current = {
            on: true,
            lx: e.clientX,
            ly: e.clientY,
            moved: false
        };
    }
    function onMove(e) {
        if (!drag.current.on) return;
        const dx = e.clientX - drag.current.lx;
        const dy = e.clientY - drag.current.ly;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
        drag.current.lx = e.clientX;
        drag.current.ly = e.clientY;
        setView((v)=>({
                ...v,
                ox: v.ox + dx,
                oy: v.oy + dy
            }));
    }
    function onUp() {
        drag.current.on = false;
    }
    const tf = `translate(${view.ox} ${view.oy}) scale(${view.scale})`;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        ref: wrapRef,
        className: "relative w-full rounded-xl border border-white/10 bg-[#0a0a0c] overflow-hidden",
        style: {
            height
        },
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
                width: vp.w,
                height: vp.h,
                className: "block select-none",
                style: {
                    cursor: drag.current.on ? "grabbing" : "grab"
                },
                onWheel: onWheel,
                onMouseDown: onDown,
                onMouseMove: onMove,
                onMouseUp: onUp,
                onMouseLeave: onUp,
                onClick: ()=>{
                    if (!drag.current.moved) {
                        setSelId(null);
                        onSelect?.(null);
                    }
                },
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("defs", {
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("marker", {
                                id: "ng-arrow",
                                viewBox: "0 0 10 10",
                                refX: "8",
                                refY: "5",
                                markerWidth: "6",
                                markerHeight: "6",
                                orient: "auto-start-reverse",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                                    d: "M0,0 L10,5 L0,10 z",
                                    fill: "rgba(148,163,184,0.8)"
                                }, void 0, false, {
                                    fileName: "[project]/src/components/NodeGraph.tsx",
                                    lineNumber: 193,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/NodeGraph.tsx",
                                lineNumber: 192,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("marker", {
                                id: "ng-arrow-active",
                                viewBox: "0 0 10 10",
                                refX: "8",
                                refY: "5",
                                markerWidth: "7",
                                markerHeight: "7",
                                orient: "auto-start-reverse",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                                    d: "M0,0 L10,5 L0,10 z",
                                    fill: "#22d3ee"
                                }, void 0, false, {
                                    fileName: "[project]/src/components/NodeGraph.tsx",
                                    lineNumber: 196,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/components/NodeGraph.tsx",
                                lineNumber: 195,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/NodeGraph.tsx",
                        lineNumber: 191,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
                        transform: tf,
                        children: [
                            edges.map((e, i)=>{
                                const s = nodeMap.get(e.source);
                                const t = nodeMap.get(e.target);
                                if (!s || !t) return null;
                                const { d } = edgePath(s, t);
                                const act = edgeActive(e);
                                const dim = active != null && !act;
                                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                                    d: d,
                                    fill: "none",
                                    stroke: act ? "#22d3ee" : "rgba(148,163,184,0.30)",
                                    strokeWidth: (act ? 2.2 : 1.2 + Math.min(2.5, (e.weight ?? 1) / 4)) / 1,
                                    markerEnd: act ? "url(#ng-arrow-active)" : "url(#ng-arrow)",
                                    opacity: dim ? 0.08 : 1,
                                    className: act ? "ng-flow" : undefined
                                }, i, false, {
                                    fileName: "[project]/src/components/NodeGraph.tsx",
                                    lineNumber: 210,
                                    columnNumber: 15
                                }, this);
                            }),
                            edges.map((e, i)=>{
                                const s = nodeMap.get(e.source);
                                const t = nodeMap.get(e.target);
                                if (!s || !t || !(e.weight && e.weight > 1)) return null;
                                if (active != null && !edgeActive(e)) return null;
                                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                                    x: (s.x + t.x) / 2,
                                    y: (s.y + t.y) / 2 - 3,
                                    textAnchor: "middle",
                                    fontSize: 10,
                                    fill: "rgba(148,163,184,0.85)",
                                    children: e.weight
                                }, "w" + i, false, {
                                    fileName: "[project]/src/components/NodeGraph.tsx",
                                    lineNumber: 229,
                                    columnNumber: 15
                                }, this);
                            }),
                            nodes.map((n)=>{
                                const dim = isDim(n.id);
                                const isActive = n.id === active;
                                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
                                    transform: `translate(${n.x - n.w / 2} ${n.y - n.h / 2})`,
                                    opacity: dim ? 0.25 : 1,
                                    style: {
                                        cursor: "pointer",
                                        transition: "opacity 0.15s"
                                    },
                                    onMouseEnter: ()=>setHoverId(n.id),
                                    onMouseLeave: ()=>setHoverId(null),
                                    onClick: (ev)=>{
                                        ev.stopPropagation();
                                        if (!drag.current.moved) {
                                            setSelId(n.id);
                                            onSelect?.(n.id);
                                        }
                                    },
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                                            width: n.w,
                                            height: n.h,
                                            rx: 9,
                                            fill: "#15151a",
                                            stroke: isActive ? "#22d3ee" : n.color,
                                            strokeWidth: isActive ? 2.2 : 1.4,
                                            style: {
                                                transition: "stroke 0.15s"
                                            }
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/NodeGraph.tsx",
                                            lineNumber: 249,
                                            columnNumber: 17
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                                            width: 5,
                                            height: n.h,
                                            rx: 2.5,
                                            fill: n.color
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/NodeGraph.tsx",
                                            lineNumber: 258,
                                            columnNumber: 17
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                                            x: 5,
                                            width: n.w - 5,
                                            height: 22,
                                            rx: 0,
                                            fill: n.color,
                                            opacity: 0.10
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/NodeGraph.tsx",
                                            lineNumber: 260,
                                            columnNumber: 17
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                                            x: 14,
                                            y: 16,
                                            fontSize: 13,
                                            fontWeight: 600,
                                            fill: "#e5e7eb",
                                            children: n.label.length > 20 ? n.label.slice(0, 19) + "…" : n.label
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/NodeGraph.tsx",
                                            lineNumber: 261,
                                            columnNumber: 17
                                        }, this),
                                        n.subtitle && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                                            x: 14,
                                            y: 36,
                                            fontSize: 10.5,
                                            fill: "#9ca3af",
                                            children: n.subtitle.length > 26 ? n.subtitle.slice(0, 25) + "…" : n.subtitle
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/NodeGraph.tsx",
                                            lineNumber: 265,
                                            columnNumber: 19
                                        }, this),
                                        n.meta && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                                            x: 14,
                                            y: n.h - 9,
                                            fontSize: 10,
                                            fill: "#6b7280",
                                            children: n.meta
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/NodeGraph.tsx",
                                            lineNumber: 270,
                                            columnNumber: 19
                                        }, this),
                                        !!n.issues && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                                            cx: n.w - 12,
                                            cy: 12,
                                            r: 4.5,
                                            fill: n.issues > 5 ? "#fb7185" : "#fbbf24"
                                        }, void 0, false, {
                                            fileName: "[project]/src/components/NodeGraph.tsx",
                                            lineNumber: 275,
                                            columnNumber: 19
                                        }, this)
                                    ]
                                }, n.id, true, {
                                    fileName: "[project]/src/components/NodeGraph.tsx",
                                    lineNumber: 240,
                                    columnNumber: 15
                                }, this);
                            })
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/components/NodeGraph.tsx",
                        lineNumber: 200,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/NodeGraph.tsx",
                lineNumber: 179,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "absolute top-3 right-3 flex items-center gap-1.5",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                        onClick: ()=>zoomBy(1 / 1.25),
                        "aria-label": "Zoom out",
                        className: "text-sm leading-none text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded w-7 h-7 flex items-center justify-center",
                        children: "−"
                    }, void 0, false, {
                        fileName: "[project]/src/components/NodeGraph.tsx",
                        lineNumber: 285,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                        onClick: ()=>zoomBy(1.25),
                        "aria-label": "Zoom in",
                        className: "text-sm leading-none text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded w-7 h-7 flex items-center justify-center",
                        children: "+"
                    }, void 0, false, {
                        fileName: "[project]/src/components/NodeGraph.tsx",
                        lineNumber: 288,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                        onClick: fit,
                        className: "text-[10px] text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded px-2 py-1 h-7",
                        children: "Fit view"
                    }, void 0, false, {
                        fileName: "[project]/src/components/NodeGraph.tsx",
                        lineNumber: 291,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/components/NodeGraph.tsx",
                lineNumber: 284,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "absolute bottom-3 left-3 text-[10px] text-gray-600",
                children: "scroll = zoom · drag = pan · hover a node to highlight its connections"
            }, void 0, false, {
                fileName: "[project]/src/components/NodeGraph.tsx",
                lineNumber: 295,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/components/NodeGraph.tsx",
        lineNumber: 174,
        columnNumber: 5
    }, this);
}
_s(NodeGraph, "l3vFmro4vpX+8UvL4K28Uw2Bc5g=");
_c = NodeGraph;
var _c;
__turbopack_context__.k.register(_c, "NodeGraph");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/layout.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// Pure layout helpers (no React). Used to position node-graph rectangles.
__turbopack_context__.s([
    "forceLayout",
    ()=>forceLayout,
    "layeredLayout",
    ()=>layeredLayout
]);
function forceLayout(ids, edges, opts = {}) {
    const n = ids.length;
    const idx = new Map(ids.map((id, i)=>[
            id,
            i
        ]));
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const vx = new Float64Array(n);
    const vy = new Float64Array(n);
    for(let i = 0; i < n; i++){
        const a = i / Math.max(1, n) * Math.PI * 2;
        const r = 160 + Math.random() * 160;
        px[i] = Math.cos(a) * r + (Math.random() - 0.5) * 30;
        py[i] = Math.sin(a) * r + (Math.random() - 0.5) * 30;
    }
    const E = edges.map((e)=>[
            idx.get(e.source),
            idx.get(e.target)
        ]).filter((e)=>e[0] !== undefined && e[1] !== undefined);
    const K = Math.max(190, 900 / Math.sqrt(n + 1)); // ideal spacing (rects are big)
    const iters = opts.iterations ?? Math.min(900, 350 + n * 3);
    let alpha = 1;
    const MAXV = 80;
    for(let it = 0; it < iters; it++){
        // Repulsion O(n^2).
        for(let i = 0; i < n; i++){
            for(let j = i + 1; j < n; j++){
                let dx = px[i] - px[j];
                let dy = py[i] - py[j];
                let d2 = dx * dx + dy * dy;
                if (d2 < 0.01) {
                    d2 = 0.01;
                    dx = Math.random();
                    dy = Math.random();
                }
                const d = Math.sqrt(d2);
                const f = K * K / d * 0.05 * alpha;
                const fx = dx / d * f;
                const fy = dy / d * f;
                vx[i] += fx;
                vy[i] += fy;
                vx[j] -= fx;
                vy[j] -= fy;
            }
        }
        // Attraction along edges.
        for (const [s, t] of E){
            const dx = px[t] - px[s];
            const dy = py[t] - py[s];
            const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const f = (d - K) / d * 0.5 * alpha;
            const fx = dx * f, fy = dy * f;
            vx[s] += fx;
            vy[s] += fy;
            vx[t] -= fx;
            vy[t] -= fy;
        }
        // Gravity + integrate.
        for(let i = 0; i < n; i++){
            vx[i] += -px[i] * 0.0015 * alpha;
            vy[i] += -py[i] * 0.0015 * alpha;
            vx[i] *= 0.85;
            vy[i] *= 0.85;
            if (vx[i] > MAXV) vx[i] = MAXV;
            else if (vx[i] < -MAXV) vx[i] = -MAXV;
            if (vy[i] > MAXV) vy[i] = MAXV;
            else if (vy[i] < -MAXV) vy[i] = -MAXV;
            px[i] += vx[i];
            py[i] += vy[i];
        }
        alpha = Math.max(0.02, alpha * 0.99);
    }
    // Collision relaxation: treat nodes as rectangles, push apart overlaps.
    if (opts.collideW && opts.collideH) {
        const cw = opts.collideW + 16;
        const ch = opts.collideH + 16;
        for(let pass = 0; pass < 60; pass++){
            let moved = false;
            for(let i = 0; i < n; i++){
                for(let j = i + 1; j < n; j++){
                    const dx = px[j] - px[i];
                    const dy = py[j] - py[i];
                    const ox = cw - Math.abs(dx);
                    const oy = ch - Math.abs(dy);
                    if (ox > 0 && oy > 0) {
                        moved = true;
                        // Resolve along the axis of least penetration.
                        if (ox < oy) {
                            const s = (dx < 0 ? -1 : 1) * ox * 0.5;
                            px[i] -= s;
                            px[j] += s;
                        } else {
                            const s = (dy < 0 ? -1 : 1) * oy * 0.5;
                            py[i] -= s;
                            py[j] += s;
                        }
                    }
                }
            }
            if (!moved) break;
        }
        // Pack disconnected components into a compact grid. Force-directed layout
        // pushes unconnected islands far apart, which makes "fit to view" zoom
        // everything down to nothing. Packing keeps the whole graph tight.
        packComponents(px, py, E, n, opts.collideW + 40, opts.collideH + 40);
    }
    const out = new Map();
    for(let i = 0; i < n; i++)out.set(ids[i], {
        x: px[i],
        y: py[i]
    });
    return out;
}
/**
 * Translate each connected component (as a rigid block, preserving its internal
 * layout) into a shelf-packed grid so islands sit next to each other instead of
 * drifting apart. Mutates px/py in place and recenters on the origin.
 */ function packComponents(px, py, E, n, boxW, boxH) {
    if (n === 0) return;
    const parent = new Int32Array(n);
    for(let i = 0; i < n; i++)parent[i] = i;
    const find = (a)=>{
        while(parent[a] !== a){
            parent[a] = parent[parent[a]];
            a = parent[a];
        }
        return a;
    };
    for (const [s, t] of E){
        const ra = find(s), rb = find(t);
        if (ra !== rb) parent[ra] = rb;
    }
    const groups = new Map();
    for(let i = 0; i < n; i++){
        const r = find(i);
        let g = groups.get(r);
        if (!g) {
            g = [];
            groups.set(r, g);
        }
        g.push(i);
    }
    if (groups.size <= 1) return;
    const comps = [];
    for (const idxs of groups.values()){
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const i of idxs){
            minX = Math.min(minX, px[i] - boxW / 2);
            maxX = Math.max(maxX, px[i] + boxW / 2);
            minY = Math.min(minY, py[i] - boxH / 2);
            maxY = Math.max(maxY, py[i] + boxH / 2);
        }
        comps.push({
            idxs,
            minX,
            minY,
            w: maxX - minX,
            h: maxY - minY
        });
    }
    comps.sort((a, b)=>b.h - a.h);
    const gap = Math.max(boxW, boxH) * 0.5;
    const totalArea = comps.reduce((sum, c)=>sum + (c.w + gap) * (c.h + gap), 0);
    const targetW = Math.max(comps[0].w, Math.sqrt(totalArea) * 1.5);
    let cursorX = 0, cursorY = 0, rowH = 0;
    for (const c of comps){
        if (cursorX > 0 && cursorX + c.w > targetW) {
            cursorX = 0;
            cursorY += rowH + gap;
            rowH = 0;
        }
        const dx = cursorX - c.minX;
        const dy = cursorY - c.minY;
        for (const i of c.idxs){
            px[i] += dx;
            py[i] += dy;
        }
        cursorX += c.w + gap;
        rowH = Math.max(rowH, c.h);
    }
    // Recenter the packed layout on the origin.
    let cx = 0, cy = 0;
    for(let i = 0; i < n; i++){
        cx += px[i];
        cy += py[i];
    }
    cx /= n;
    cy /= n;
    for(let i = 0; i < n; i++){
        px[i] -= cx;
        py[i] -= cy;
    }
}
function layeredLayout(ids, edges, tierOf, box) {
    const tiers = new Map();
    for (const id of ids){
        const t = tierOf.get(id) ?? 0;
        if (!tiers.has(t)) tiers.set(t, []);
        tiers.get(t).push(id);
    }
    const tierKeys = [
        ...tiers.keys()
    ].sort((a, b)=>b - a); // high tier on top
    // Crossing reduction: order each row by barycenter of neighbors in the row above.
    const order = new Map();
    tierKeys.forEach((t, rowIdx)=>{
        const row = tiers.get(t);
        if (rowIdx === 0) {
            row.forEach((id, i)=>order.set(id, i));
        } else {
            const prev = tierKeys[rowIdx - 1];
            const prevSet = new Set(tiers.get(prev));
            const bary = (id)=>{
                const neigh = [];
                for (const e of edges){
                    if (e.source === id && prevSet.has(e.target)) neigh.push(order.get(e.target) ?? 0);
                    if (e.target === id && prevSet.has(e.source)) neigh.push(order.get(e.source) ?? 0);
                }
                return neigh.length ? neigh.reduce((a, b)=>a + b, 0) / neigh.length : 1e9;
            };
            row.sort((a, b)=>bary(a) - bary(b));
            row.forEach((id, i)=>order.set(id, i));
        }
    });
    // Wrap very wide tiers into multiple sub-rows so boxes stay readable.
    const MAX_COLS = 8;
    const maxCols = Math.max(1, ...tierKeys.map((t)=>Math.min(MAX_COLS, tiers.get(t).length)));
    const width = 60 * 2 + maxCols * box.w + (maxCols - 1) * box.hGap;
    const pos = new Map();
    let cursorY = 50;
    for (const t of tierKeys){
        const row = tiers.get(t);
        const cols = Math.min(MAX_COLS, Math.max(1, row.length));
        const subRows = Math.ceil(row.length / cols);
        for(let sr = 0; sr < subRows; sr++){
            const slice = row.slice(sr * cols, sr * cols + cols);
            const rowW = slice.length * box.w + (slice.length - 1) * box.hGap;
            const startX = (width - rowW) / 2;
            slice.forEach((id, i)=>{
                pos.set(id, {
                    x: startX + i * (box.w + box.hGap) + box.w / 2,
                    y: cursorY + box.h / 2
                });
            });
            cursorY += box.h + box.vGap;
        }
    }
    const height = cursorY - box.vGap + 50;
    return {
        pos,
        width,
        height
    };
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/fleet/page.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>FleetPage
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/client/app-dir/link.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$arrow$2d$left$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ArrowLeft$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/arrow-left.mjs [app-client] (ecmascript) <export default as ArrowLeft>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$loader$2d$circle$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Loader2$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/loader-circle.mjs [app-client] (ecmascript) <export default as Loader2>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$network$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Network$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/network.mjs [app-client] (ecmascript) <export default as Network>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$NodeGraph$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/NodeGraph.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$layout$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/layout.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
;
;
;
;
function FleetPage() {
    _s();
    const [graph, setGraph] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [loading, setLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "FleetPage.useEffect": ()=>{
            fetch("/api/fleet").then({
                "FleetPage.useEffect": (res)=>res.json()
            }["FleetPage.useEffect"]).then({
                "FleetPage.useEffect": (data)=>{
                    setGraph(data);
                    setLoading(false);
                }
            }["FleetPage.useEffect"]).catch({
                "FleetPage.useEffect": ()=>setLoading(false)
            }["FleetPage.useEffect"]);
        }
    }["FleetPage.useEffect"], []);
    if (loading) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "flex items-center gap-2 text-gray-500 py-24 justify-center",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$loader$2d$circle$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Loader2$3e$__["Loader2"], {
                    className: "w-4 h-4 animate-spin"
                }, void 0, false, {
                    fileName: "[project]/src/app/fleet/page.tsx",
                    lineNumber: 27,
                    columnNumber: 9
                }, this),
                " Mapping enterprise fleet…"
            ]
        }, void 0, true, {
            fileName: "[project]/src/app/fleet/page.tsx",
            lineNumber: 26,
            columnNumber: 7
        }, this);
    }
    if (!graph || graph.nodes.length === 0) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "max-w-4xl mx-auto px-6 py-24 text-center text-gray-400",
            children: [
                "No indexed repositories found. ",
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                    href: "/",
                    className: "text-purple-400",
                    children: "Start indexing"
                }, void 0, false, {
                    fileName: "[project]/src/app/fleet/page.tsx",
                    lineNumber: 35,
                    columnNumber: 40
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/src/app/fleet/page.tsx",
            lineNumber: 34,
            columnNumber: 7
        }, this);
    }
    const ngNodes = [];
    const ngEdges = graph.edges.map((e)=>({
            source: e.source,
            target: e.target,
            weight: 1
        }));
    const pos = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$layout$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["forceLayout"])(graph.nodes.map((n)=>n.id), ngEdges, {
        collideW: 180,
        collideH: 64,
        iterations: 400
    });
    for (const n of graph.nodes){
        const p = pos.get(n.id) || {
            x: 0,
            y: 0
        };
        ngNodes.push({
            id: n.id,
            x: p.x,
            y: p.y,
            w: 180,
            h: 64,
            label: n.name,
            subtitle: n.sourceType === "git" ? "git repo" : "local folder",
            meta: `${n.loc.toLocaleString()} LOC · Score: ${n.score || 0}`,
            color: n.score && n.score >= 80 ? "#34d399" : n.score && n.score >= 60 ? "#fbbf24" : "#fb7185"
        });
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "max-w-6xl mx-auto px-6 py-12",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                href: "/dashboard",
                className: "inline-flex items-center gap-2 text-sm text-gray-500 hover:text-white mb-6 transition-colors",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$arrow$2d$left$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__ArrowLeft$3e$__["ArrowLeft"], {
                        className: "w-4 h-4"
                    }, void 0, false, {
                        fileName: "[project]/src/app/fleet/page.tsx",
                        lineNumber: 67,
                        columnNumber: 9
                    }, this),
                    " Dashboard"
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/fleet/page.tsx",
                lineNumber: 66,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex flex-wrap items-end justify-between gap-4 mb-6",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("h1", {
                            className: "text-3xl font-bold text-white tracking-tight flex items-center gap-3",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$network$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Network$3e$__["Network"], {
                                    className: "w-8 h-8 text-cyan-400"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/fleet/page.tsx",
                                    lineNumber: 73,
                                    columnNumber: 13
                                }, this),
                                " Enterprise Fleet Graph"
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/fleet/page.tsx",
                            lineNumber: 72,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                            className: "text-sm text-gray-500 mt-2",
                            children: [
                                "Cross-repository dependency map built from ",
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                    children: "package.json"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/fleet/page.tsx",
                                    lineNumber: 76,
                                    columnNumber: 56
                                }, this),
                                " and ",
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                    children: "requirements.txt"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/fleet/page.tsx",
                                    lineNumber: 76,
                                    columnNumber: 86
                                }, this),
                                " analysis."
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/fleet/page.tsx",
                            lineNumber: 75,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/fleet/page.tsx",
                    lineNumber: 71,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/app/fleet/page.tsx",
                lineNumber: 70,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "mb-6",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$NodeGraph$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["NodeGraph"], {
                    nodes: ngNodes,
                    edges: ngEdges,
                    height: 700
                }, void 0, false, {
                    fileName: "[project]/src/app/fleet/page.tsx",
                    lineNumber: 82,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/app/fleet/page.tsx",
                lineNumber: 81,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/fleet/page.tsx",
        lineNumber: 65,
        columnNumber: 5
    }, this);
}
_s(FleetPage, "mn4oYHh0cX2928YHEkc+mign3ms=");
_c = FleetPage;
var _c;
__turbopack_context__.k.register(_c, "FleetPage");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/node_modules/next/dist/compiled/react/cjs/react-jsx-dev-runtime.development.js [app-client] (ecmascript)", ((__turbopack_context__, module, exports) => {
"use strict";

var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = /*#__PURE__*/ __turbopack_context__.i("[project]/node_modules/next/dist/build/polyfills/process.js [app-client] (ecmascript)");
/**
 * @license React
 * react-jsx-dev-runtime.development.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */ "use strict";
"production" !== ("TURBOPACK compile-time value", "development") && function() {
    function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type) return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch(type){
            case REACT_FRAGMENT_TYPE:
                return "Fragment";
            case REACT_PROFILER_TYPE:
                return "Profiler";
            case REACT_STRICT_MODE_TYPE:
                return "StrictMode";
            case REACT_SUSPENSE_TYPE:
                return "Suspense";
            case REACT_SUSPENSE_LIST_TYPE:
                return "SuspenseList";
            case REACT_ACTIVITY_TYPE:
                return "Activity";
            case REACT_VIEW_TRANSITION_TYPE:
                return "ViewTransition";
        }
        if ("object" === typeof type) switch("number" === typeof type.tag && console.error("Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."), type.$$typeof){
            case REACT_PORTAL_TYPE:
                return "Portal";
            case REACT_CONTEXT_TYPE:
                return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
                return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
                var innerType = type.render;
                type = type.displayName;
                type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
                return type;
            case REACT_MEMO_TYPE:
                return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
                innerType = type._payload;
                type = type._init;
                try {
                    return getComponentNameFromType(type(innerType));
                } catch (x) {}
        }
        return null;
    }
    function testStringCoercion(value) {
        return "" + value;
    }
    function checkKeyStringCoercion(value) {
        try {
            testStringCoercion(value);
            var JSCompiler_inline_result = !1;
        } catch (e) {
            JSCompiler_inline_result = !0;
        }
        if (JSCompiler_inline_result) {
            JSCompiler_inline_result = console;
            var JSCompiler_temp_const = JSCompiler_inline_result.error;
            var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
            JSCompiler_temp_const.call(JSCompiler_inline_result, "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.", JSCompiler_inline_result$jscomp$0);
            return testStringCoercion(value);
        }
    }
    function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE) return "<...>";
        try {
            var name = getComponentNameFromType(type);
            return name ? "<" + name + ">" : "<...>";
        } catch (x) {
            return "<...>";
        }
    }
    function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
    }
    function UnknownOwner() {
        return Error("react-stack-top-frame");
    }
    function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
            var getter = Object.getOwnPropertyDescriptor(config, "key").get;
            if (getter && getter.isReactWarning) return !1;
        }
        return void 0 !== config.key;
    }
    function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
            specialPropKeyWarningShown || (specialPropKeyWarningShown = !0, console.error("%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)", displayName));
        }
        warnAboutAccessingKey.isReactWarning = !0;
        Object.defineProperty(props, "key", {
            get: warnAboutAccessingKey,
            configurable: !0
        });
    }
    function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = !0, console.error("Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
    }
    function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
            $$typeof: REACT_ELEMENT_TYPE,
            type: type,
            key: key,
            props: props,
            _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
            enumerable: !1,
            get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", {
            enumerable: !1,
            value: null
        });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
            configurable: !1,
            enumerable: !1,
            writable: !0,
            value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
            configurable: !1,
            enumerable: !1,
            writable: !0,
            value: null
        });
        Object.defineProperty(type, "_debugStack", {
            configurable: !1,
            enumerable: !1,
            writable: !0,
            value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
            configurable: !1,
            enumerable: !1,
            writable: !0,
            value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
    }
    function jsxDEVImpl(type, config, maybeKey, isStaticChildren, debugStack, debugTask) {
        var children = config.children;
        if (void 0 !== children) if (isStaticChildren) if (isArrayImpl(children)) {
            for(isStaticChildren = 0; isStaticChildren < children.length; isStaticChildren++)validateChildKeys(children[isStaticChildren]);
            Object.freeze && Object.freeze(children);
        } else console.error("React.jsx: Static children should always be an array. You are likely explicitly calling React.jsxs or React.jsxDEV. Use the Babel transform instead.");
        else validateChildKeys(children);
        if (hasOwnProperty.call(config, "key")) {
            children = getComponentNameFromType(type);
            var keys = Object.keys(config).filter(function(k) {
                return "key" !== k;
            });
            isStaticChildren = 0 < keys.length ? "{key: someKey, " + keys.join(": ..., ") + ": ...}" : "{key: someKey}";
            didWarnAboutKeySpread[children + isStaticChildren] || (keys = 0 < keys.length ? "{" + keys.join(": ..., ") + ": ...}" : "{}", console.error('A props object containing a "key" prop is being spread into JSX:\n  let props = %s;\n  <%s {...props} />\nReact keys must be passed directly to JSX without using spread:\n  let props = %s;\n  <%s key={someKey} {...props} />', isStaticChildren, children, keys, children), didWarnAboutKeySpread[children + isStaticChildren] = !0);
        }
        children = null;
        void 0 !== maybeKey && (checkKeyStringCoercion(maybeKey), children = "" + maybeKey);
        hasValidKey(config) && (checkKeyStringCoercion(config.key), children = "" + config.key);
        if ("key" in config) {
            maybeKey = {};
            for(var propName in config)"key" !== propName && (maybeKey[propName] = config[propName]);
        } else maybeKey = config;
        children && defineKeyPropWarningGetter(maybeKey, "function" === typeof type ? type.displayName || type.name || "Unknown" : type);
        return ReactElement(type, children, maybeKey, getOwner(), debugStack, debugTask);
    }
    function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
    }
    function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
    }
    var React = __turbopack_context__.r("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)"), REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = Symbol.for("react.memo"), REACT_LAZY_TYPE = Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = Symbol.for("react.activity"), REACT_VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition"), REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference"), ReactSharedInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, hasOwnProperty = Object.prototype.hasOwnProperty, isArrayImpl = Array.isArray, createTask = console.createTask ? console.createTask : function() {
        return null;
    };
    React = {
        react_stack_bottom_frame: function(callStackForError) {
            return callStackForError();
        }
    };
    var specialPropKeyWarningShown;
    var didWarnAboutElementRef = {};
    var unknownOwnerDebugStack = React.react_stack_bottom_frame.bind(React, UnknownOwner)();
    var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
    var didWarnAboutKeySpread = {};
    exports.Fragment = REACT_FRAGMENT_TYPE;
    exports.jsxDEV = function(type, config, maybeKey, isStaticChildren) {
        var trackActualOwner = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        if (trackActualOwner) {
            var previousStackTraceLimit = Error.stackTraceLimit;
            Error.stackTraceLimit = 10;
            var debugStackDEV = Error("react-stack-top-frame");
            Error.stackTraceLimit = previousStackTraceLimit;
        } else debugStackDEV = unknownOwnerDebugStack;
        return jsxDEVImpl(type, config, maybeKey, isStaticChildren, debugStackDEV, trackActualOwner ? createTask(getTaskName(type)) : unknownOwnerDebugTask);
    };
}();
}),
"[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)", ((__turbopack_context__, module, exports) => {
"use strict";

var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = /*#__PURE__*/ __turbopack_context__.i("[project]/node_modules/next/dist/build/polyfills/process.js [app-client] (ecmascript)");
'use strict';
if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
;
else {
    module.exports = __turbopack_context__.r("[project]/node_modules/next/dist/compiled/react/cjs/react-jsx-dev-runtime.development.js [app-client] (ecmascript)");
}
}),
"[project]/node_modules/lucide-react/dist/esm/shared/src/utils/toKebabCase.mjs [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "toKebabCase",
    ()=>toKebabCase
]);
/**
 * @license lucide-react v1.22.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */ const toKebabCase = (string)=>string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
;
}),
"[project]/node_modules/lucide-react/dist/esm/shared/src/utils/toCamelCase.mjs [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "toCamelCase",
    ()=>toCamelCase
]);
/**
 * @license lucide-react v1.22.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */ const toCamelCase = (string)=>string.replace(/^([A-Z])|[\s-_]+(\w)/g, (match, p1, p2)=>p2 ? p2.toUpperCase() : p1.toLowerCase());
;
}),
"[project]/node_modules/lucide-react/dist/esm/shared/src/utils/toPascalCase.mjs [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "toPascalCase",
    ()=>toPascalCase
]);
/**
 * @license lucide-react v1.22.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$shared$2f$src$2f$utils$2f$toCamelCase$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/shared/src/utils/toCamelCase.mjs [app-client] (ecmascript)");
;
const toPascalCase = (string)=>{
    const camelCase = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$shared$2f$src$2f$utils$2f$toCamelCase$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toCamelCase"])(string);
    return camelCase.charAt(0).toUpperCase() + camelCase.slice(1);
};
;
}),
"[project]/node_modules/lucide-react/dist/esm/createLucideIcon.mjs [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>createLucideIcon
]);
/**
 * @license lucide-react v1.22.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$shared$2f$src$2f$utils$2f$mergeClasses$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/shared/src/utils/mergeClasses.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$shared$2f$src$2f$utils$2f$toKebabCase$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/shared/src/utils/toKebabCase.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$shared$2f$src$2f$utils$2f$toPascalCase$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/shared/src/utils/toPascalCase.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$Icon$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/Icon.mjs [app-client] (ecmascript)");
;
;
;
;
;
const createLucideIcon = (iconName, iconNode)=>{
    const Component = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["forwardRef"])(({ className, ...props }, ref)=>(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createElement"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$Icon$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
            ref,
            iconNode,
            className: (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$shared$2f$src$2f$utils$2f$mergeClasses$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["mergeClasses"])(`lucide-${(0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$shared$2f$src$2f$utils$2f$toKebabCase$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toKebabCase"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$shared$2f$src$2f$utils$2f$toPascalCase$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toPascalCase"])(iconName))}`, `lucide-${iconName}`, className),
            ...props
        }));
    Component.displayName = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$shared$2f$src$2f$utils$2f$toPascalCase$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toPascalCase"])(iconName);
    return Component;
};
;
}),
"[project]/node_modules/lucide-react/dist/esm/icons/arrow-left.mjs [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "__iconNode",
    ()=>__iconNode,
    "default",
    ()=>ArrowLeft
]);
/**
 * @license lucide-react v1.22.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$createLucideIcon$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/createLucideIcon.mjs [app-client] (ecmascript)");
;
const __iconNode = [
    [
        "path",
        {
            d: "m12 19-7-7 7-7",
            key: "1l729n"
        }
    ],
    [
        "path",
        {
            d: "M19 12H5",
            key: "x3x0zl"
        }
    ]
];
const ArrowLeft = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$createLucideIcon$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"])("arrow-left", __iconNode);
;
}),
"[project]/node_modules/lucide-react/dist/esm/icons/arrow-left.mjs [app-client] (ecmascript) <export default as ArrowLeft>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ArrowLeft",
    ()=>__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$arrow$2d$left$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"]
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$arrow$2d$left$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/arrow-left.mjs [app-client] (ecmascript)");
}),
"[project]/node_modules/lucide-react/dist/esm/icons/loader-circle.mjs [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "__iconNode",
    ()=>__iconNode,
    "default",
    ()=>LoaderCircle
]);
/**
 * @license lucide-react v1.22.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$createLucideIcon$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/createLucideIcon.mjs [app-client] (ecmascript)");
;
const __iconNode = [
    [
        "path",
        {
            d: "M21 12a9 9 0 1 1-6.219-8.56",
            key: "13zald"
        }
    ]
];
const LoaderCircle = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$createLucideIcon$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"])("loader-circle", __iconNode);
;
}),
"[project]/node_modules/lucide-react/dist/esm/icons/loader-circle.mjs [app-client] (ecmascript) <export default as Loader2>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Loader2",
    ()=>__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$loader$2d$circle$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"]
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$loader$2d$circle$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/loader-circle.mjs [app-client] (ecmascript)");
}),
"[project]/node_modules/lucide-react/dist/esm/icons/network.mjs [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "__iconNode",
    ()=>__iconNode,
    "default",
    ()=>Network
]);
/**
 * @license lucide-react v1.22.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$createLucideIcon$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/createLucideIcon.mjs [app-client] (ecmascript)");
;
const __iconNode = [
    [
        "rect",
        {
            x: "16",
            y: "16",
            width: "6",
            height: "6",
            rx: "1",
            key: "4q2zg0"
        }
    ],
    [
        "rect",
        {
            x: "2",
            y: "16",
            width: "6",
            height: "6",
            rx: "1",
            key: "8cvhb9"
        }
    ],
    [
        "rect",
        {
            x: "9",
            y: "2",
            width: "6",
            height: "6",
            rx: "1",
            key: "1egb70"
        }
    ],
    [
        "path",
        {
            d: "M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3",
            key: "1jsf9p"
        }
    ],
    [
        "path",
        {
            d: "M12 12V8",
            key: "2874zd"
        }
    ]
];
const Network = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$createLucideIcon$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"])("network", __iconNode);
;
}),
"[project]/node_modules/lucide-react/dist/esm/icons/network.mjs [app-client] (ecmascript) <export default as Network>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "Network",
    ()=>__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$network$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"]
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$network$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/network.mjs [app-client] (ecmascript)");
}),
]);

//# sourceMappingURL=_1s11xi_._.js.map