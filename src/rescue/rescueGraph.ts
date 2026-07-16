/**
 * PHASE_4C828 / PHASE_4C830 — Pan India Rescue Intelligence Layer
 * Core Graph Models & Types (Hardened)
 * 
 * Strict type definitions for the graph-based multi-modal routing engine.
 * Purely additive; uses LRU caches to prevent memory leaks.
 */

import { LruTtlCache } from './lruTtlCache';

export interface RouteNode {
  readonly code: string;
  readonly name: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly zone: string;
  readonly division: string;
  readonly category: 'JUNCTION' | 'MAJOR_TERMINAL' | 'STANDARD';
}

export interface RouteEdge {
  readonly source: string;      // StationCode
  readonly destination: string; // StationCode
  readonly distanceKm: number;
  readonly averageDelayMins: number;
  readonly successRate: number; // 0-1 based on learning
}

export interface JourneyGraph {
  readonly nodes: LruTtlCache<string, RouteNode>;
  readonly edges: LruTtlCache<string, RouteEdge[]>;
  readonly version: string;
}

export interface HubGraph {
  readonly hubs: string[]; // List of major hub station codes
  readonly connectionMatrix: Record<string, string[]>; // hub -> adjacent hubs
}

export interface RegionGraph {
  readonly zones: string[];
  readonly interZoneCongestion: Record<string, number>; // zone-pair -> multiplier
}

export interface TravelGraph {
  readonly journeyId: string;
  readonly travelDate: string;
  readonly path: RouteEdge[];
  readonly totalDurationMins: number;
}

// ─── Future Booking Gateway Hooks (Interfaces Only) ──────────────────────────

export interface BookingHook {
  readonly providerId: string;
  readonly canFulfilEdge: (edge: RouteEdge) => boolean;
  readonly getBookingProbability: (edge: RouteEdge) => number;
}

export interface MultiModalSupport {
  readonly allowsBus: boolean;
  readonly allowsFlight: boolean;
  readonly allowsHotelLayover: boolean;
}

// ─── Basic In-Memory Graph Builder (Memory Hardened) ─────────────────────────

export class RescueGraphBuilder {
  private static instance: RescueGraphBuilder;
  
  // Hardened caches: Max 10k nodes, 20k edges. 24 Hour TTL.
  private nodes = new LruTtlCache<string, RouteNode>(10000, 86400000);
  private edges = new LruTtlCache<string, RouteEdge[]>(20000, 86400000);

  private constructor() {}

  public static getInstance(): RescueGraphBuilder {
    if (!RescueGraphBuilder.instance) {
      RescueGraphBuilder.instance = new RescueGraphBuilder();
    }
    return RescueGraphBuilder.instance;
  }

  public addNode(node: RouteNode): void {
    this.nodes.set(node.code, node);
  }

  public addEdge(edge: RouteEdge): void {
    const existing = this.edges.get(edge.source) || [];
    existing.push(edge);
    this.edges.set(edge.source, existing);
  }

  public getGraph(): JourneyGraph {
    return {
      nodes: this.nodes,
      edges: this.edges,
      version: '1.0.0-rescue-intelligence'
    };
  }

  public clear(): void {
    this.nodes.clear();
    this.edges.clear();
  }

  public dispose(): void {
    this.nodes.dispose();
    this.edges.dispose();
  }

  public getMemoryStats() {
    return {
      nodesCache: this.nodes.getStats(),
      edgesCache: this.edges.getStats()
    };
  }
}
