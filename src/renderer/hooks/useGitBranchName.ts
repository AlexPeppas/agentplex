import { useEffect, useState } from 'react';

export function useGitBranchName(sessionId: string, cwd: string | undefined, enabled: boolean): string | null {
  const [branchName, setBranchName] = useState<string | null>(null);
  useEffect(() => {
    setBranchName(null);
    if (!enabled) return;
    let cancelled = false;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const info = await window.agentPlex.gitBranchInfo(sessionId, false);
        if (!cancelled) setBranchName(info?.current ?? null);
      } catch (error) {
        console.error('[git] Cannot read branch label:', error);
        if (!cancelled) setBranchName(null);
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sessionId, cwd, enabled]);
  return branchName;
}
