export interface RouteRule {
  sourcePatterns: string[];
  destPatterns: string[];
  hubs: string[];
}

export const MAJOR_JUNCTIONS = [
  "NDLS", "HWH", "CSMT", "MAS", "SBC", "PNBE", "GKP", "LKO", "CNB", "PRYJ", 
  "DDU", "BSL", "NGP", "ET", "BPL", "BRC", "RTM", "KOTA", "ADI", "JP", 
  "SC", "BZA", "VSKP", "KGP", "BBS", "SUR", "PUNE", "ST", "MMCT", "BDTS"
];

export const ROUTE_RULES: RouteRule[] = [
  {
    sourcePatterns: ["CSMT", "MMCT", "BDTS", "LTT", "DDR"],
    destPatterns: ["NDLS", "NZM", "DLI", "ANVT"],
    hubs: ["BRC", "RTM", "KOTA", "MTJ", "ST"]
  },
  {
    sourcePatterns: ["CSMT", "LTT", "DDR"],
    destPatterns: ["HWH", "SDAH", "KOAA"],
    hubs: ["BSL", "NGP", "R", "BSP", "TATA"]
  },
  {
    sourcePatterns: ["NDLS", "NZM", "DLI"],
    destPatterns: ["MAS", "SBC", "YPR"],
    hubs: ["BPL", "ET", "NGP", "BPQ", "BZA"]
  },
  {
    sourcePatterns: ["HWH", "SDAH"],
    destPatterns: ["MAS", "SBC", "YPR"],
    hubs: ["KGP", "BBS", "VSKP", "BZA"]
  }
];
