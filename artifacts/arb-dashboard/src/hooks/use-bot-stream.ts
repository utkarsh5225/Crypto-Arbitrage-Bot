import { useEffect, useState, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BotStats, ArbitrageOpportunity, PaperTrade } from '@workspace/api-client-react';
import { getGetStatsQueryKey, getGetOpportunitiesQueryKey, getGetTradesQueryKey } from '@workspace/api-client-react';

// Must match the params used by Dashboard.tsx queries exactly so cache writes land
// in the same cache slot that the UI reads from.
const OPP_PARAMS = { limit: 50 } as const;
const TRADES_PARAMS = { limit: 50 } as const;

/** Rolling metric samples kept for the performance charts (~5 min at 2s cadence). */
const MAX_HISTORY = 150;

export interface LiveTradeFailure {
  path: string[];
  failedLeg: number;
  error: string;
  timestamp: string;
}

export interface MetricSample {
  t: number; // Date.now() when sampled
  pnl: number; // cumulative total P&L (USD)
  oppMin: number; // opportunities per minute
  pps: number; // paths evaluated per second
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

/** Short WebAudio beep — no asset required. Best-effort; ignores autoplay blocks. */
function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close().catch(() => {});
    }, 150);
  } catch {
    /* ignore */
  }
}

function notify(title: string, body: string): void {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {
    /* ignore */
  }
}

export function useBotStream() {
  const queryClient = useQueryClient();
  const [scannerConnected, setScannerConnected] = useState(false);
  const [liveTradeFailure, setLiveTradeFailure] = useState<LiveTradeFailure | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [lastStatsAt, setLastStatsAt] = useState<number | null>(null);
  const [history, setHistory] = useState<MetricSample[]>([]);
  const [alertsEnabled, setAlertsEnabled] = useState(false);

  // Event listeners close over their initial state; a ref lets them read the
  // current alert preference without re-subscribing the EventSource.
  const alertsRef = useRef(alertsEnabled);
  alertsRef.current = alertsEnabled;

  const toggleAlerts = useCallback(async () => {
    if (!alertsRef.current && 'Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
    setAlertsEnabled((v) => !v);
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/stream');

    es.onopen = () => setConnectionState('open');
    // EventSource auto-reconnects on error; surface that so the UI can warn.
    es.onerror = () => setConnectionState('reconnecting');

    es.addEventListener('opportunity', (e) => {
      try {
        const opp = JSON.parse(e.data) as ArbitrageOpportunity;
        queryClient.setQueryData(getGetOpportunitiesQueryKey(OPP_PARAMS), (old: any) => {
          if (!old) return { data: [opp], total: 1 };
          return { ...old, data: [opp, ...old.data].slice(0, OPP_PARAMS.limit), total: old.total + 1 };
        });
      } catch (_e) {}
    });

    es.addEventListener('trade', (e) => {
      try {
        const trade = JSON.parse(e.data) as PaperTrade;
        queryClient.setQueryData(getGetTradesQueryKey(TRADES_PARAMS), (old: any) => {
          if (!old) return { data: [trade], total: 1 };
          return { ...old, data: [trade, ...old.data].slice(0, TRADES_PARAMS.limit), total: old.total + 1 };
        });
        // Alert on real fills only — paper trades fire constantly.
        if (trade.mode === 'live' && alertsRef.current) {
          const pnl = trade.netProfitUsd >= 0 ? `+$${trade.netProfitUsd.toFixed(2)}` : `-$${Math.abs(trade.netProfitUsd).toFixed(2)}`;
          notify('Live trade filled', `${trade.path.join(' → ')}  ${pnl}`);
          beep();
        }
      } catch (_e) {}
    });

    es.addEventListener('stats', (e) => {
      try {
        const stats = JSON.parse(e.data) as BotStats;
        queryClient.setQueryData(getGetStatsQueryKey(), stats);
        setScannerConnected(stats.scannerConnected);
        setConnectionState('open');
        setLastStatsAt(Date.now());
        setHistory((prev) => {
          const next = [
            ...prev,
            {
              t: Date.now(),
              pnl: stats.totalProfitUsd ?? 0,
              oppMin: stats.opportunitiesPerMinute ?? 0,
              pps: stats.pathsPerSecond ?? 0,
            },
          ];
          return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
        });
      } catch (err) {}
    });

    es.addEventListener('scanner_status', (e) => {
      try {
        const { connected } = JSON.parse(e.data);
        setScannerConnected(connected);
        queryClient.setQueryData(getGetStatsQueryKey(), (old: any) => {
          if (!old) return old;
          return { ...old, scannerConnected: connected };
        });
      } catch (err) {}
    });

    es.addEventListener('live_trade_failed', (e) => {
      try {
        const failure = JSON.parse(e.data) as LiveTradeFailure;
        setLiveTradeFailure(failure);
        if (alertsRef.current) {
          notify('⚠️ Live trade FAILED', `${failure.path.join(' → ')} · leg ${failure.failedLeg}\n${failure.error}`);
          beep();
        }
      } catch (_e) {}
    });

    return () => {
      es.close();
    };
  }, [queryClient]);

  return {
    scannerConnected,
    liveTradeFailure,
    dismissFailure: () => setLiveTradeFailure(null),
    connectionState,
    lastStatsAt,
    history,
    alertsEnabled,
    toggleAlerts,
  };
}
