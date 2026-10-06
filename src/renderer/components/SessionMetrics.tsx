import { useEffect, useMemo, useState } from 'react';
import { Clock3 } from 'lucide-react';
import type { SessionUsage } from '../../shared/ipc-channels';

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (totalMinutes < 1) return '<1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function pressureColor(percent: number): string {
  if (percent >= 85) return 'var(--error)';
  if (percent >= 60) return 'var(--warning)';
  return 'var(--success)';
}

export function ContextMeter({
  usage,
  supported = true,
  compact = false,
}: {
  usage: SessionUsage | null;
  supported?: boolean;
  compact?: boolean;
}) {
  const percent = useMemo(() => {
    if (!usage?.contextWindowTokens) return null;
    return Math.min(100, Math.max(0, (usage.contextTokens / usage.contextWindowTokens) * 100));
  }, [usage]);

  if (!usage) {
    const pendingLabel = supported ? 'Waiting for usage' : 'Restart to enable usage';
    const pendingTitle = supported
      ? 'Context usage is waiting for the provider event stream'
      : 'The running AgentPlex main process predates context telemetry. Restart AgentPlex to enable it.';
    if (compact) {
      return (
        <span className="flex items-center gap-1.5 shrink-0" title={pendingTitle}>
          <span className="w-10 h-1 rounded-full overflow-hidden bg-border">
            <span className={`block h-full w-1/4 rounded-full bg-fg-muted/40 ${supported ? 'animate-pulse' : ''}`} />
          </span>
          <span className="text-[9px] tabular-nums text-fg-muted">—</span>
        </span>
      );
    }
    return (
      <div className="flex items-center gap-2 min-w-[210px]" title={pendingTitle}>
        <div className="flex-1 min-w-[90px]">
          <div className="h-1.5 rounded-full overflow-hidden bg-border">
            <div className={`h-full w-1/4 rounded-full bg-fg-muted/40 ${supported ? 'animate-pulse' : ''}`} />
          </div>
        </div>
        <span className="text-[10px] text-fg-muted whitespace-nowrap">{pendingLabel}</span>
      </div>
    );
  }

  const label = usage.contextWindowTokens
    ? `${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextWindowTokens)}`
    : `${formatTokens(usage.contextTokens)} tokens`;
  const detail = [
    `Input ${formatTokens(usage.inputTokens)}`,
    `Output ${formatTokens(usage.outputTokens)}`,
    `Cache read ${formatTokens(usage.cacheReadTokens)}`,
    `Cache write ${formatTokens(usage.cacheWriteTokens)}`,
  ].join(' · ');

  if (usage.snapshotSource) {
    const source = usage.snapshotSource === 'copilot-checkpoint' ? 'Last main-conversation prompt'
      : usage.snapshotSource === 'copilot-compaction' ? 'Context after compaction' : 'Context at last CLI shutdown';
    return (
      <span className={`text-fg-muted tabular-nums whitespace-nowrap ${compact ? 'text-[9px]' : 'text-[10px]'}`}
        title={`${source}: ${usage.contextTokens.toLocaleString()} tokens. Recorded ${new Date(usage.updatedAt).toLocaleString()}. Snapshot, not live /context usage; context capacity unavailable.`}>
        {formatTokens(usage.contextTokens)}{compact ? ' (snapshot)' : ' tokens · snapshot'}
      </span>
    );
  }

  if (compact) {
    return (
      <span className="flex items-center gap-1.5 shrink-0" title={`${label} · ${detail}`}>
        <span className="w-10 h-1 rounded-full overflow-hidden bg-border">
          <span
            className="block h-full rounded-full transition-[width,background-color] duration-300"
            style={{
              width: `${percent ?? 8}%`,
              backgroundColor: percent === null ? 'var(--text-muted)' : pressureColor(percent),
            }}
          />
        </span>
        <span className="text-[9px] tabular-nums text-fg-muted">{formatTokens(usage.contextTokens)}</span>
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2 min-w-[170px]" title={detail}>
      <div className="flex-1 min-w-[90px]">
        <div className="h-1.5 rounded-full overflow-hidden bg-border">
          <div
            className="h-full rounded-full transition-[width,background-color] duration-300"
            style={{
              width: `${percent ?? 8}%`,
              backgroundColor: percent === null ? 'var(--text-muted)' : pressureColor(percent),
            }}
          />
        </div>
      </div>
      <span className="text-[10px] tabular-nums text-fg-muted whitespace-nowrap">
        {label}{percent !== null ? ` · ${Math.round(percent)}%` : ''}
      </span>
    </div>
  );
}

export function SessionAge({
  startedAt,
  lastActivityAt,
  compact = false,
}: {
  startedAt: number;
  lastActivityAt: number;
  compact?: boolean;
}) {
  const now = useNow();
  const age = formatDuration(now - startedAt);
  const idle = formatDuration(now - lastActivityAt);

  if (compact) {
    return (
      <span className="text-[9px] tabular-nums text-fg-muted shrink-0" title={`Active ${age} · Last activity ${idle} ago`}>
        {age}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-[10px] tabular-nums text-fg-muted whitespace-nowrap" title={`Last activity ${idle} ago`}>
      <Clock3 size={11} />
      Active {age}
    </span>
  );
}
