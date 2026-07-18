"use strict";
/**
 * PHASE_4C828 / PHASE_4C830 — Pan India Rescue Intelligence Layer
 * Core Graph Models & Types (Hardened)
 *
 * Strict type definitions for the graph-based multi-modal routing engine.
 * Purely additive; uses LRU caches to prevent memory leaks.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RescueGraphBuilder = void 0;
const lruTtlCache_1 = require("./lruTtlCache");
// ─── Basic In-Memory Graph Builder (Memory Hardened) ─────────────────────────
class RescueGraphBuilder {
    constructor() {
        // Hardened caches: Max 10k nodes, 20k edges. 24 Hour TTL.
        this.nodes = new lruTtlCache_1.LruTtlCache(10000, 86400000);
        this.edges = new lruTtlCache_1.LruTtlCache(20000, 86400000);
    }
    static getInstance() {
        if (!RescueGraphBuilder.instance) {
            RescueGraphBuilder.instance = new RescueGraphBuilder();
        }
        return RescueGraphBuilder.instance;
    }
    addNode(node) {
        this.nodes.set(node.code, node);
    }
    addEdge(edge) {
        const existing = this.edges.get(edge.source) || [];
        existing.push(edge);
        this.edges.set(edge.source, existing);
    }
    getGraph() {
        return {
            nodes: this.nodes,
            edges: this.edges,
            version: '1.0.0-rescue-intelligence'
        };
    }
    clear() {
        this.nodes.clear();
        this.edges.clear();
    }
    dispose() {
        this.nodes.dispose();
        this.edges.dispose();
    }
    getMemoryStats() {
        return {
            nodesCache: this.nodes.getStats(),
            edgesCache: this.edges.getStats()
        };
    }
}
exports.RescueGraphBuilder = RescueGraphBuilder;
