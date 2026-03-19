/**
 * useAgentOrchestration — React hook for multi-agent TUI state.
 *
 * Subscribes to the OrchestratorBus and exposes agent state for rendering.
 */

import { useState, useEffect, useCallback, useRef } from "react";

// Types inline to avoid import issues with monorepo
interface AgentInfo {
  id: string;
  name: string;
  role: string;
  icon: string;
  color: string;
  task: string;
  status: string;
  spawnedAt: Date;
}

interface SpawnRequestInfo {
  id: string;
  persona: string;
  personaName: string;
  personaIcon: string;
  task: string;
  reason: string;
}

export interface AgentOrchestrationState {
  agents: AgentInfo[];
  activeAgentId: string | null;
  activeAgentName: string;
  activeAgentColor: string;
  chatMode: boolean;
  autoSpawn: boolean;
  pendingSpawns: SpawnRequestInfo[];
}

export interface AgentOrchestrationActions {
  cycleAgent: () => void;
  setActiveAgent: (id: string | null) => void;
  approveSpawn: (requestId: string) => void;
  rejectSpawn: (requestId: string) => void;
  killAgent: (id: string) => void;
  toggleAutoSpawn: () => void;
  enterChatMode: () => void;
  exitChatMode: () => void;
  spawnAgent: (personaId: string, task: string) => void;
}

export function useAgentOrchestration(): AgentOrchestrationState & AgentOrchestrationActions {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [chatMode, setChatMode] = useState(false);
  const [autoSpawn, setAutoSpawn] = useState(false);
  const [pendingSpawns, setPendingSpawns] = useState<SpawnRequestInfo[]>([]);
  const busRef = useRef<any>(null);

  // Lazily resolve the orchestrator bus
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const { getOrchestratorBus } = await import("../../../../packages/orchestration/orchestrator-bus.js");
        const { getPersona } = await import("../../../../packages/orchestration/personas.js");
        const bus = getOrchestratorBus();
        busRef.current = bus;

        const refreshAgents = () => {
          if (!mounted) return;
          const agentList = bus.getAgents().map((a: any) => ({
            id: a.id,
            name: a.persona.name,
            role: a.persona.role,
            icon: a.persona.icon,
            color: a.persona.color,
            task: a.task,
            status: a.status,
            spawnedAt: a.spawnedAt,
          }));
          setAgents(agentList);
        };

        const handleSpawnRequest = (request: any) => {
          if (!mounted) return;
          const p = getPersona(request.persona);
          if (!p) return;
          setPendingSpawns(prev => [...prev, {
            id: request.id,
            persona: request.persona,
            personaName: p.name,
            personaIcon: p.icon,
            task: request.task,
            reason: request.reason,
          }]);
        };

        const handleSpawnResolved = (request: any) => {
          if (!mounted) return;
          setPendingSpawns(prev => prev.filter(s => s.id !== request.id));
          refreshAgents();
        };

        bus.on("agent:spawned", refreshAgents);
        bus.on("agent:completed", refreshAgents);
        bus.on("agent:failed", refreshAgents);
        bus.on("agent:killed", refreshAgents);
        bus.on("spawn:request", handleSpawnRequest);
        bus.on("spawn:approved", handleSpawnResolved);
        bus.on("spawn:rejected", handleSpawnResolved);

        refreshAgents();
      } catch {
        // Orchestration not available
      }
    })();

    return () => { mounted = false; };
  }, []);

  const cycleAgent = useCallback(() => {
    if (agents.length === 0) return;

    const currentIndex = activeAgentId
      ? agents.findIndex(a => a.id === activeAgentId)
      : -1;

    // null (Eight) → first agent → second agent → ... → null (Eight)
    if (currentIndex === -1) {
      setActiveAgentId(agents[0].id);
    } else if (currentIndex >= agents.length - 1) {
      setActiveAgentId(null); // Back to Eight
    } else {
      setActiveAgentId(agents[currentIndex + 1].id);
    }
  }, [agents, activeAgentId]);

  const approveSpawn = useCallback((requestId: string) => {
    busRef.current?.approveSpawn(requestId);
  }, []);

  const rejectSpawn = useCallback((requestId: string) => {
    busRef.current?.rejectSpawn(requestId);
  }, []);

  const killAgent = useCallback((id: string) => {
    busRef.current?.killAgent(id);
  }, []);

  const toggleAutoSpawn = useCallback(() => {
    const newVal = !autoSpawn;
    setAutoSpawn(newVal);
    busRef.current?.setAutoSpawn(newVal);
  }, [autoSpawn]);

  const enterChatMode = useCallback(() => setChatMode(true), []);
  const exitChatMode = useCallback(() => setChatMode(false), []);

  const spawnAgent = useCallback((personaId: string, task: string) => {
    busRef.current?.requestSpawn(personaId, task, "Manual spawn by user");
  }, []);

  const activeAgent = activeAgentId
    ? agents.find(a => a.id === activeAgentId)
    : null;

  return {
    agents,
    activeAgentId,
    activeAgentName: activeAgent?.name || "Eight",
    activeAgentColor: activeAgent?.color || "cyan",
    chatMode,
    autoSpawn,
    pendingSpawns,
    cycleAgent,
    setActiveAgent: setActiveAgentId,
    approveSpawn,
    rejectSpawn,
    killAgent,
    toggleAutoSpawn,
    enterChatMode,
    exitChatMode,
    spawnAgent,
  };
}
