import { useEffect, useState, useMemo, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { toast } from 'sonner';
import type { DomainRule } from '../../../shared/types';

interface Connection {
  id: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  metadata?: {
    host?: string;
    destinationIP?: string;
  };
}

interface Node {
  id: string;
  name: string;
  type: 'source' | 'rule' | 'outbound';
  value: number;
  x: number;
  y: number;
  height: number;
  color: string;
}

interface Link {
  source: string;
  target: string;
  value: number;
  path: string;
  color: string;
  sourceY: number;
  targetY: number;
  heightSource: number;
  heightTarget: number;
}

const POLL_INTERVAL = 2000;
const FIXED_HEIGHT = 450; // Increased to match RealTimeLogs approximate height
const PADDING_Y = 20;
const PADDING_X = 20;
const PADDING_LEFT = 20; // Reverted back to 20, keeping it 'blocked' as requested
const NODE_WIDTH = 6; // Slightly thinner
const NODE_GAP = 12; // Slightly tighter gap for sleeker look? Or larger for more breath? User said "chubby", usually means too tall/thick.
// Actually user said "fat", often meaning the ribbons are very tall. Reducing height helps.

export function ConnectionTopology() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState<{ type: 'node' | 'link'; id: string } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; domain: string } | null>(
    null
  );
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);

  // Responsive Container Logic
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800); // Default start width

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentBoxSize) {
          // Provide a slight debounce or just set it? React 18 handles batching well.
          // We need the width of the container content
          setWidth(entry.contentRect.width);
        }
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Fetch connections with better error handling and CORS check
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const fetchConnections = async () => {
      try {
        // Ensure proxy is running before fetching?
        // We catch errors anyway.
        const res = await fetch('http://127.0.0.1:9090/connections', {
          mode: 'cors',
          headers: config?.clashApiSecret
            ? { Authorization: `Bearer ${config.clashApiSecret}` }
            : {},
        });
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        const data = await res.json();
        setConnections(data.connections || []);
        setError(null);
      } catch (e) {
        console.error('Failed to fetch connections', e);
        // Only show error if we have no connections to show?
        // Or just fail silently but log?
        // Let's set error state to maybe show a friendly message if persistent.
        setError(t('home.topologyApiError'));
      } finally {
        setLoading(false);
      }
    };
    fetchConnections();
    timer = setInterval(fetchConnections, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [config?.clashApiSecret]);

  const { nodes, links } = useMemo(() => {
    // Only recalc if we have width and connections
    if (connections.length === 0 || width === 0) return { nodes: [], links: [] };

    // --- 1. Data Aggregation ---
    // We want to breakdown generic rules (final) by Host to give more detail

    // Better Aggregation Structure
    const middleNodes = new Map<string, { value: number; flows: Map<string, number> }>();
    const outboundTotals = new Map<string, number>();

    connections.forEach((conn) => {
      let name = conn.rule;
      const metadata = conn.metadata || {};

      // Prioritize Host/IP for display to show actual websites, falling back to Rule
      if (metadata.host) {
        name = metadata.host;
      } else if (metadata.destinationIP) {
        name = metadata.destinationIP;
      } else if (conn.rulePayload) {
        name = `${conn.rule}: ${conn.rulePayload}`;
      }

      let outbound = 'Direct';
      if (conn.chains && conn.chains.length > 0) {
        outbound = conn.chains[0];
      }

      // Update Middle Node
      if (!middleNodes.has(name)) {
        middleNodes.set(name, { value: 0, flows: new Map() });
      }
      const node = middleNodes.get(name)!;
      node.value += 1;
      node.flows.set(outbound, (node.flows.get(outbound) || 0) + 1);

      // Update Outbound Totals
      outboundTotals.set(outbound, (outboundTotals.get(outbound) || 0) + 1);
    });

    // --- 2. Node Selection (Top N) ---
    const MAX_NODES = 15;
    let sortedMiddle = Array.from(middleNodes.entries()).sort((a, b) => b[1].value - a[1].value);

    // Filter out potential noise or empty names if any
    sortedMiddle = sortedMiddle.filter(([n]) => n && n.trim() !== '');

    if (sortedMiddle.length > MAX_NODES) {
      const top = sortedMiddle.slice(0, MAX_NODES);
      const others = sortedMiddle.slice(MAX_NODES);

      const startValue = { value: 0, flows: new Map<string, number>() };
      const othersNode = others.reduce((acc, [_, data]) => {
        acc.value += data.value;
        data.flows.forEach((v, k) => {
          acc.flows.set(k, (acc.flows.get(k) || 0) + v);
        });
        return acc;
      }, startValue);

      sortedMiddle = [...top, [t('home.others'), othersNode]];
    }

    // --- 3. Layout Calculation (Responsive) ---
    const nodeList: Node[] = [];
    const availableHeight = FIXED_HEIGHT - 2 * PADDING_Y;

    // Prepare Outbounds
    const sortedOutbounds = Array.from(outboundTotals.entries()).sort((a, b) => b[1] - a[1]);

    // Determine total connections (for source node)
    const totalConnections = sortedMiddle.reduce((acc, [_, d]) => acc + d.value, 0);

    const middleCount = sortedMiddle.length;
    const outboundCount = sortedOutbounds.length;

    const totalMiddleGap = Math.max(0, middleCount - 1) * NODE_GAP;
    const totalOutboundGap = Math.max(0, outboundCount - 1) * NODE_GAP;

    // Scale Logic: Ensure items fit in height.
    const maxContentHeight = availableHeight - Math.max(totalMiddleGap, totalOutboundGap);
    const autoScale = maxContentHeight / (totalConnections || 1);
    const MAX_SCALE = 30; // Max pixels per connection (prevents single connection from being massive)
    const scale = Math.min(autoScale > 0 ? autoScale : MAX_SCALE, MAX_SCALE);

    const SHIFT_RIGHT = 35; // Shift the entire layout right to fill empty space

    // Source Node
    const sourceNode: Node = {
      id: 'source',
      name: t('home.myDevice'),
      type: 'source',
      value: totalConnections,
      x: PADDING_LEFT + SHIFT_RIGHT,
      y: PADDING_Y,
      height: Math.max(2, totalConnections * scale),
      color: '#6366f1', // Indigo-500
    };
    sourceNode.y = (FIXED_HEIGHT - sourceNode.height) / 2;
    nodeList.push(sourceNode);

    // Middle Nodes
    // Center the group vertically
    const middleGroupHeight =
      sortedMiddle.reduce((acc, [_, d]) => acc + Math.max(2, d.value * scale), 0) + totalMiddleGap;
    let currentY = (FIXED_HEIGHT - middleGroupHeight) / 2;

    const midNodeParams = new Map<string, Node>();
    // Responsive X positions
    const middleX = width * 0.45 + SHIFT_RIGHT; // 45% of width + shift

    sortedMiddle.forEach(([name, data]) => {
      const h = Math.max(2, data.value * scale);
      const node: Node = {
        id: `mid-${name}`,
        name: name,
        type: 'rule',
        value: data.value,
        x: middleX,
        y: currentY,
        height: h,
        color: name === t('home.others') ? '#94a3b8' : '#10b981', // Slate-400 or Emerald-500
      };
      nodeList.push(node);
      midNodeParams.set(name, node);
      currentY += h + NODE_GAP;
    });

    // Outbound Nodes
    const outGroupHeight =
      sortedOutbounds.reduce((acc, [_, v]) => acc + Math.max(2, v * scale), 0) + totalOutboundGap;
    currentY = (FIXED_HEIGHT - outGroupHeight) / 2;

    const outNodeParams = new Map<string, Node>();
    const outYCursorMap = new Map<string, number>();
    const outboundX = width - PADDING_X - 120 + SHIFT_RIGHT; // Right side with padding for text + shift

    sortedOutbounds.forEach(([name, val]) => {
      const h = Math.max(2, val * scale);
      const node: Node = {
        id: `out-${name}`,
        name: name,
        type: 'outbound',
        value: val,
        x: outboundX,
        y: currentY,
        height: h,
        color: '#f59e0b', // Amber-500
      };
      nodeList.push(node);
      outNodeParams.set(name, node);
      outYCursorMap.set(name, currentY);
      currentY += h + NODE_GAP;
    });

    // --- 4. Links ---
    const linkList: Link[] = [];

    // Source -> Middle
    let sourceCursor = sourceNode.y;
    sortedMiddle.forEach(([name, data]) => {
      const midNode = midNodeParams.get(name)!;
      const val = data.value;
      const h = (val / totalConnections) * sourceNode.height; // Proportional height at source

      linkList.push({
        source: sourceNode.id,
        target: midNode.id,
        value: val,
        sourceY: sourceCursor,
        targetY: midNode.y,
        heightSource: h,
        heightTarget: midNode.height,
        color: 'url(#gradient-source)',
        path: getSankeyPath(
          sourceNode.x + NODE_WIDTH,
          sourceCursor,
          midNode.x,
          midNode.y,
          h,
          midNode.height
        ),
      });
      sourceCursor += h;
    });

    // Middle -> Outbound
    sortedMiddle.forEach(([name, data]) => {
      const midNode = midNodeParams.get(name)!;
      let midCursor = midNode.y;

      sortedOutbounds.forEach(([outName, _]) => {
        const flowVal = data.flows.get(outName);
        if (!flowVal) return;

        const outNode = outNodeParams.get(outName)!;

        // Proportions based on Node Heights
        const midH = (flowVal / data.value) * midNode.height;
        const outH = (flowVal / outNode.value) * outNode.height;
        const outCursor = outYCursorMap.get(outName)!;

        linkList.push({
          source: midNode.id,
          target: outNode.id,
          value: flowVal,
          sourceY: midCursor,
          targetY: outCursor,
          heightSource: midH,
          heightTarget: outH,
          color: 'url(#gradient-rule)',
          path: getSankeyPath(midNode.x + NODE_WIDTH, midCursor, outNode.x, outCursor, midH, outH),
        });

        midCursor += midH;
        outYCursorMap.set(outName, outCursor + outH);
      });
    });

    return { nodes: nodeList, links: linkList };
  }, [connections, width]); // Dep on width

  // --- Interaction Logic ---

  // Trace Logic: Identify all connected nodes/links for a given hover
  const highlightedIds = useMemo(() => {
    if (!hovered) return new Set<string>();

    const set = new Set<string>();
    set.add(hovered.id);

    // Helper to find connections
    // We look at links.
    // If Node is hovered:
    //   - Find all links connected to this Node.
    //   - Find all nodes connected to those links.
    //   - Recurse? Or just 1 level?
    //   For Source->Middle->Outbound, 1 level recursion is likely enough if we start from Middle.
    //   - If Source: Source -> All links -> All Middle -> All Middle-Out Links -> All Outbound. (Too much?)
    //   - If Middle: Middle -> Link(Source-Middle) -> Source. AND Middle -> Links(Middle-Out) -> Outbound.
    //   - If Outbound: Outbound -> Links(Middle-Out) -> Middle -> Link(Source-Middle) -> Source.

    // Let's check relationships
    // links array has { source: ID, target: ID }

    // Simple iterative expansion
    // We want to highlight the FULL PATH that flow through this element.

    // Pass 1: Find direct connections
    const relevantLinks: Link[] = [];

    if (hovered.type === 'node') {
      links.forEach((l, idx) => {
        if (l.source === hovered.id || l.target === hovered.id) {
          set.add(`link-${idx}`);
          set.add(l.source);
          set.add(l.target);
          relevantLinks.push(l);
        }
      });
    } else {
      // It's a link
      const idx = parseInt(hovered.id.split('-')[1]);
      if (links[idx]) {
        const l = links[idx];
        set.add(l.source);
        set.add(l.target);
        relevantLinks.push(l);
      }
    }

    // Pass 2: Expand from the newly added nodes (extend the path)
    // Logic: If we have a Middle Node highlighted, ensure we get its Source link and Outbound links?
    // Wait, if I hover "Middle", I just got Source and Outbounds added in Pass 1.
    // Now I need the links connecting Source->Middle (already there) and Middle->Outbound (already there).
    // But what about: If I hover Outbound, I got Middle nodes.
    // Do I need the Source->Middle links for those Middle nodes?
    // Yes, user wants "Whole Chain".

    // Iterative approach:
    // Loop a few times to propagate? Or specific logic.

    // Specific logic for 3-tier:
    // Tier 1: Source. Tier 2: Middle. Tier 3: Outbound.

    // If any element is in set, check if we need to extend upstream or downstream.

    // Upstream extension (towards Source)
    // If a Middle node is in Set, find Link(Source->Middle) and Source.
    // If Outbound node is in Set, find Link(Middle->Outbound) and Middle. (Already done in Pass 1 for Outbound hover?)

    // Let's run a robust check on all links:
    // If a link's target IS IN SET, add link and link.source to set.
    // If a link's source IS IN SET, add link and link.target to set.
    // This spreads the highlight.
    // We need to distinguish "Flow".
    // Highlight flows that pass through the hovered element.

    // Correct Logic:
    // IF Hover Node X:
    //   Highlight all paths passing through X.
    //   Path = Source -> Middle -> Outbound.
    //   If X is Source: All paths.
    //   If X is Middle: The specific Source->Middle link, The node Source, The node Middle, All Middle->Outbound links, All Outbound nodes connected.
    //   If X is Outbound: All Middle->Outbound links connected to X, properties' Middle Nodes, their Source->Middle links, Source Node.

    // IF Hover Link Y (Source->Middle):
    //   Path is this link extended to Outbounds.
    //   Highlight Source, Middle, Link Y.
    //   Highlight all Middle->Outbound links appearing from Middle. Highlight those Outbounds.

    // IF Hover Link Z (Middle->Outbound):
    //   Path is this link extended to Source.
    //   Highlight Middle, Outbound, Link Z.
    //   Highlight Source->Middle link. Highlight Source.

    // Implementation:
    // Just check connectivity.
    // 1. Identify which "Middle Nodes" are involved.
    //    - If Source hovered: All Middle nodes.
    //    - If Middle hovered: Just that ID.
    //    - If Outbound hovered: All Middle nodes feeding this Outbound.
    //    - If Link(Source-Mid) hovered: The target Middle Node.
    //    - If Link(Mid-Out) hovered: The source Middle Node.

    const involvedMiddleNodes = new Set<string>();

    if (hovered.type === 'node') {
      if (hovered.id === 'source') {
        // All middles
        nodes.filter((n) => n.id.startsWith('mid-')).forEach((n) => involvedMiddleNodes.add(n.id));
      } else if (hovered.id.startsWith('mid-')) {
        involvedMiddleNodes.add(hovered.id);
      } else if (hovered.id.startsWith('out-')) {
        // Find all middles connected to this outbound
        links.forEach((l) => {
          if (l.target === hovered.id) involvedMiddleNodes.add(l.source);
        });
      }
    } else {
      // Link
      const idx = parseInt(hovered.id.split('-')[1]);
      const l = links[idx];
      if (l) {
        if (l.source.startsWith('mid-')) involvedMiddleNodes.add(l.source); // Link is Mid->Out
        if (l.target.startsWith('mid-')) involvedMiddleNodes.add(l.target); // Link is Source->Mid
      }
    }

    // Now, for every Involved Middle Node, highlight the Full Path associated with it?
    // Wait, if I hover Outbound, I only want the paths reaching THAT Outbound.
    // If "Google" goes to "Proxy" and "Direct".
    // And "Twitter" goes to "Proxy".
    // Hover "Proxy": Highlight Google->Proxy and Twitter->Proxy.
    // DO NOT highlight Google->Direct.

    // So we need specific Links.

    // 1. Initial Set of Relevant Links.
    const selectedLinks = new Set<number>(); // indices

    links.forEach((l, idx) => {
      let meaningful = false;

      if (hovered.type === 'node') {
        if (l.source === hovered.id || l.target === hovered.id) meaningful = true;
      } else {
        const hIdx = parseInt(hovered.id.split('-')[1]);
        if (hIdx === idx) meaningful = true;

        const hLink = links[hIdx];
        // Chaining:
        // If hovered is Source->Mid (l1), and this l is Mid->Out (l2).
        // meaningful if l2.source == l1.target.
        if (hLink && l.source === hLink.target) meaningful = true;

        // If hovered is Mid->Out (l1), and this l is Source->Mid (l2).
        // meaningful if l2.target == l1.source.
        if (hLink && l.target === hLink.source) meaningful = true;
      }

      if (meaningful) selectedLinks.add(idx);
    });

    // Filtering step:
    // The above logic is additive "OR". It might be too broad.
    // E.g. Hover "Proxy" (Outbound).
    // Meaningful links: All Mid->Proxy links.
    // BUT: also need Source->Mid links?
    // The logic "l.target == hovered.id" catches Mid->Proxy.
    // It DOES NOT catch Source->Mid.
    // We need a second pass or recursive expansion.

    // Refined Algorithm:
    // Start with Direct Links connected to Hovered Item.

    // Expand Upstream and Downstream

    // Perform fixed iterations (2 passes is enough for depth 3 graph)
    // Perform fixed iterations (2 passes is enough for depth 3 graph)
    for (let pass = 0; pass < 2; pass++) {
      links.forEach(() => {
        // If this link connects to any link in finalLinks (node sharing), check validity of flow.
        // We only care about matching Node IDs.

        // If l.target matches source of a highlighted link (Upstream extension)
        // Only if we are not breaking scope? e.g. Outbound Hover -> Mid->Out Link -> Source->Mid Link.
        // Yes, we want that.

        // If l.source matches target of a highlighted link (Downstream extension)
        // Hover Source -> Source->Mid Link -> Mid->Out Link.

        // ISSUE: Use of Middle Node as hub.
        // If I hover "Proxy", I get "Google->Proxy" link.
        // This triggers "Source->Google" link.
        // Does it also trigger "Google->Direct" link?
        // "Google->Direct" shares "Google" node.
        // BUT it is not on the path to "Proxy".
        // We must avoid highlighting "Google->Direct" if we only care about "Proxy".

        // CONSTRAINT:
        // If we are expanding Upstream (Source-ward), we take ALL feeds. (Source->Mid always feeds Mid).
        // If we are expanding Downstream (Outbound-ward), we ONLY take branches if...
        // Actually, if I hover "Google", I want ALL its Upstream (Source) and ALL its Downstream (Outbound).
        // If I hover "Proxy", I want its Upstream (Google->Proxy), and Google's Upstream (Source->Google).
        // I DO NOT want Google's other Downstreams (Google->Direct).

        // Logic:
        // 1. Identify "Focal Nodes" that initiate the highlight?
        //    - Hover Node: It is the focus.
        //    - Hover Link: Both endpoints are focus.

        // 2. Determine Directionality of interest.
        //    - Everything upstream of Focus is relevant.
        //    - Everything downstream of Focus is relevant.
        //    - Sibling branches (Fork upstream or downstream) are NOT relevant unless Focus is the fork point.

        // Implementation:
        // Collect all Upstream Paths from Focus.
        // Collect all Downstream Paths from Focus.

        // Nodes in Focus:
        let focusNodes: string[] = [];
        if (hovered.type === 'node') focusNodes = [hovered.id];
        else {
          const idx = parseInt(hovered.id.split('-')[1]);
          const hL = links[idx];
          if (hL) focusNodes = [hL.source, hL.target];
        }

        // Upstream: Reachable by traversing links "target -> source"
        let upstreamNodes = new Set<string>(focusNodes);
        let changed = true;
        while (changed) {
          changed = false;
          links.forEach((tmpl) => {
            if (upstreamNodes.has(tmpl.target) && !upstreamNodes.has(tmpl.source)) {
              upstreamNodes.add(tmpl.source);
              changed = true;
            }
          });
        }

        // Downstream: Reachable by traversing links "source -> target"
        let downstreamNodes = new Set<string>(focusNodes);
        changed = true;
        while (changed) {
          changed = false;
          links.forEach((tmpl) => {
            if (downstreamNodes.has(tmpl.source) && !downstreamNodes.has(tmpl.target)) {
              downstreamNodes.add(tmpl.target);
              changed = true;
            }
          });
        }

        const allNodes = new Set([...upstreamNodes, ...downstreamNodes]);
        allNodes.forEach((id) => set.add(id));

        links.forEach((tmpl, i) => {
          if (allNodes.has(tmpl.source) && allNodes.has(tmpl.target)) {
            set.add(`link-${i}`);
          }
        });
      });
    }

    return set;
  }, [hovered, links, nodes]);

  const getNodeOpacity = (nodeId: string) => {
    if (!hovered) return 1;
    return highlightedIds.has(nodeId) ? 1 : 0.1;
  };

  const getLinkOpacity = (index: number) => {
    if (!hovered) return 0.4;
    return highlightedIds.has(`link-${index}`) ? 0.8 : 0.05;
  };

  // Tooltip Content logic
  const getTooltipContent = () => {
    if (!hovered) return null;

    if (hovered.type === 'node') {
      const node = nodes.find((n) => n.id === hovered.id);
      if (!node) return null;
      return (
        <div className="bg-popover text-popover-foreground px-3 py-2 rounded-md shadow-lg border border-border text-xs z-50 animate-in fade-in zoom-in-95 duration-200">
          <div className="font-bold mb-1">{node.name}</div>
          <div>
            {t('home.type')}: {node.type}
          </div>
          <div>
            {t('home.connections')}: {node.value}
          </div>
        </div>
      );
    }

    if (hovered.type === 'link') {
      const index = parseInt(hovered.id.split('-')[1]);
      const link = links[index];
      if (!link) return null;

      // Find the "Middle" node associated with this link to show its details
      // Link is either Source->Middle or Middle->Outbound
      let mainNodeId: string | null = null;
      if (link.target.startsWith('mid-')) mainNodeId = link.target;
      if (link.source.startsWith('mid-')) mainNodeId = link.source;

      const mainNode = mainNodeId ? nodes.find((n) => n.id === mainNodeId) : null;

      // If we found a middle node, show its details primarily
      if (mainNode) {
        return (
          <div className="bg-popover text-popover-foreground px-3 py-2 rounded-md shadow-lg border border-border text-xs z-50 animate-in fade-in zoom-in-95 duration-200 chat-bubble">
            <div className="font-bold mb-1">{mainNode.name}</div>
            <div className="text-muted-foreground mb-1">
              {t('home.type')}: {mainNode.type}
            </div>
            <div className="border-t border-border my-1 pt-1 flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('home.flow')}</span>
              <span>
                {mainNode.value === 1
                  ? t('home.connectionSingle', { count: link.value })
                  : t('home.connectionPlural', { count: link.value })}
              </span>
            </div>
          </div>
        );
      }

      const sourceName = nodes.find((n) => n.id === link.source)?.name || link.source;
      const targetName = nodes.find((n) => n.id === link.target)?.name || link.target;

      return (
        <div className="bg-popover text-popover-foreground px-3 py-2 rounded-md shadow-lg border border-border text-xs z-50 animate-in fade-in zoom-in-95 duration-200 chat-bubble">
          <div className="font-bold mb-1">{t('home.flowDetail')}</div>
          <div className="flex items-center gap-1 mb-1">
            <span className="max-w-[100px] truncate">{sourceName}</span>
            <span>→</span>
            <span className="max-w-[100px] truncate">{targetName}</span>
          </div>
          <div>
            {t('home.connections')}: {link.value}
          </div>
        </div>
      );
    }
    return null;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // Relative to the container
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setMousePos({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }
  };

  const handleMouseLeave = () => {
    setHovered(null);
  };

  const handleMouseEnter = (type: 'node' | 'link', id: string) => {
    setHovered({ type, id });
  };

  // -------- Right-click: Add domain to rule --------
  const handleNodeContextMenu = (e: React.MouseEvent, node: Node) => {
    // Only allow right-click on domain (middle/rule) nodes, not source or outbound
    if (node.type !== 'rule') return;
    // Skip 'Others' group node
    if (node.name === t('home.others')) return;
    // Only show menu for domain-like names (contains dots or is a valid host)
    if (!node.name.includes('.') && !node.name.includes(':')) return;

    e.preventDefault();
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setContextMenu({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      domain: node.name,
    });
  };

  const addDomainRule = async (domain: string, action: DomainRule['action']) => {
    if (!config) return;
    setContextMenu(null);

    // Extract root domain (e.g. 'sub.example.com' -> 'example.com')
    const parts = domain.split('.');
    const rootDomain = parts.length > 2 ? parts.slice(-2).join('.') : domain;

    // Check if a rule already covers this domain
    const existing = config.customRules.find(
      (r) => r.domains.includes(domain) || r.domains.includes(rootDomain)
    );
    if (existing) {
      toast.info(t('home.domainAlreadyInRule', { domain }));
      return;
    }

    const newRule: DomainRule = {
      id: `topology-${Date.now()}`,
      domains: [domain],
      action,
      enabled: true,
    };

    try {
      await saveConfig({
        ...config,
        customRules: [...config.customRules, newRule],
      });
      const actionLabel =
        action === 'proxy'
          ? t('home.ruleProxy')
          : action === 'direct'
            ? t('home.ruleDirect')
            : t('home.ruleBlock');
      toast.success(t('home.domainRuleAdded', { domain, action: actionLabel }));
    } catch {
      toast.error(t('home.domainRuleAddFail'));
    }
  };

  return (
    <Card className="col-span-1">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="h-5 w-5" />
          {t('home.connectionTopology')}
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-hidden">
        <div
          ref={containerRef}
          style={{ width: '100%', height: `${FIXED_HEIGHT}px` }}
          className="relative cursor-default"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {loading && connections.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground h-full">
              {t('home.loading')}
            </div>
          )}

          {!loading && connections.length === 0 && !error && (
            <div className="absolute inset-0 text-muted-foreground text-sm flex flex-col items-center justify-center gap-2 h-full">
              <Network className="h-8 w-8 opacity-50" />
              <span>{t('home.noActiveConnections')}</span>
            </div>
          )}

          {error && connections.length === 0 && (
            <div className="absolute inset-0 text-muted-foreground text-sm flex flex-col items-center justify-center gap-2 text-yellow-500 h-full">
              <Network className="h-8 w-8 opacity-50" />
              <span>{error}</span>
            </div>
          )}

          {/* Tooltip Layer */}
          {hovered && !contextMenu && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: mousePos.x + 10,
                top: mousePos.y + 10,
              }}
            >
              {getTooltipContent()}
            </div>
          )}

          {/* Right-click Context Menu */}
          {contextMenu && (
            <>
              {/* Backdrop to close menu */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setContextMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu(null);
                }}
              />
              <div
                className="absolute z-50 min-w-[180px] rounded-lg border border-border bg-popover shadow-lg text-popover-foreground text-sm overflow-hidden"
                style={{ left: contextMenu.x, top: contextMenu.y }}
              >
                <div className="px-3 py-2 border-b border-border">
                  <p className="font-medium truncate max-w-[160px]" title={contextMenu.domain}>
                    {contextMenu.domain}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('home.addToRule')}</p>
                </div>
                <div className="py-1">
                  <button
                    className="w-full text-left px-3 py-2 hover:bg-accent flex items-center gap-2 transition-colors"
                    onClick={() => addDomainRule(contextMenu.domain, 'proxy')}
                  >
                    <span className="h-2 w-2 rounded-full bg-blue-500 inline-block" />
                    {t('home.ruleProxy')}
                  </button>
                  <button
                    className="w-full text-left px-3 py-2 hover:bg-accent flex items-center gap-2 transition-colors"
                    onClick={() => addDomainRule(contextMenu.domain, 'direct')}
                  >
                    <span className="h-2 w-2 rounded-full bg-green-500 inline-block" />
                    {t('home.ruleDirect')}
                  </button>
                  <button
                    className="w-full text-left px-3 py-2 hover:bg-accent flex items-center gap-2 transition-colors text-destructive"
                    onClick={() => addDomainRule(contextMenu.domain, 'block')}
                  >
                    <span className="h-2 w-2 rounded-full bg-red-500 inline-block" />
                    {t('home.ruleBlock')}
                  </button>
                </div>
              </div>
            </>
          )}

          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${width} ${FIXED_HEIGHT}`}
            className="overflow-visible font-sans"
          >
            <defs>
              <linearGradient
                id="gradient-source"
                gradientUnits="userSpaceOnUse"
                x1="0"
                x2={width * 0.45}
                y1="0"
                y2="0"
              >
                <stop offset="0%" stopColor="#818cf8" stopOpacity="0.4" />
                <stop offset="100%" stopColor="#34d399" stopOpacity="0.4" />
              </linearGradient>
              <linearGradient
                id="gradient-rule"
                gradientUnits="userSpaceOnUse"
                x1={width * 0.45}
                x2={width}
                y1="0"
                y2="0"
              >
                <stop offset="0%" stopColor="#34d399" stopOpacity="0.4" />
                <stop offset="100%" stopColor="#fbbf24" stopOpacity="0.4" />
              </linearGradient>
            </defs>

            {/* Links */}
            {links.map((link, i) => (
              <path
                key={`link-${i}`}
                d={link.path}
                fill={link.color}
                opacity={getLinkOpacity(i)}
                className="transition-opacity duration-300"
                onMouseEnter={() => handleMouseEnter('link', `link-${i}`)}
                // don't leave immediately to allow moving to node
              />
            ))}

            {/* Nodes */}
            {nodes.map((node) => (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                opacity={getNodeOpacity(node.id)}
                className="transition-opacity duration-300"
                onMouseEnter={() => handleMouseEnter('node', node.id)}
                onContextMenu={(e) => handleNodeContextMenu(e, node)}
                style={node.type === 'rule' ? { cursor: 'context-menu' } : undefined}
              >
                <rect width={NODE_WIDTH} height={node.height} fill={node.color} rx={1} />
                <text
                  x={node.type === 'outbound' ? NODE_WIDTH + 8 : -8}
                  y={node.height / 2}
                  dy=".32em"
                  className="text-[11px] font-medium fill-foreground select-none pointer-events-none"
                  textAnchor={node.type === 'outbound' ? 'start' : 'end'}
                >
                  {/* Truncate name based on available space? For now fixed len is safe */}
                  {node.name.length > 25 ? node.name.substring(0, 22) + '...' : node.name}
                </text>
                <text
                  x={node.type === 'outbound' ? -6 : NODE_WIDTH + 6}
                  y={node.height / 2}
                  dy=".32em"
                  className="text-[9px] text-muted-foreground fill-muted-foreground select-none pointer-events-none"
                  textAnchor={node.type === 'outbound' ? 'end' : 'start'}
                >
                  {node.value}
                </text>
                {/* Hit area for easier hover */}
                <rect
                  x={-10}
                  y={0}
                  width={NODE_WIDTH + 20}
                  height={node.height}
                  fill="transparent"
                />
              </g>
            ))}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}

function getSankeyPath(x0: number, y0: number, x1: number, y1: number, h0: number, h1: number) {
  const xi = (x0 + x1) / 2;
  const topCurve = `M ${x0} ${y0} C ${xi} ${y0}, ${xi} ${y1}, ${x1} ${y1}`;
  const rightLine = `L ${x1} ${y1 + h1}`;
  const bottomCurve = `C ${xi} ${y1 + h1}, ${xi} ${y0 + h0}, ${x0} ${y0 + h0}`;
  const close = `L ${x0} ${y0} Z`;
  return `${topCurve} ${rightLine} ${bottomCurve} ${close}`;
}
