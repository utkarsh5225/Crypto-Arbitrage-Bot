import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BotStats, ArbitrageOpportunity, PaperTrade } from '@workspace/api-client-react';
import { getGetStatsQueryKey, getGetOpportunitiesQueryKey, getGetTradesQueryKey } from '@workspace/api-client-react';

// Must match the params used by Dashboard.tsx queries exactly so cache writes land
// in the same cache slot that the UI reads from.
const OPP_PARAMS = { limit: 50 } as const;
const TRADES_PARAMS = { limit: 50 } as const;

export interface LiveTradeFailure {
  path: string[];
  failedLeg: number;
  error: string;
  timestamp: string;
}

export function useBotStream() {
  const queryClient = useQueryClient();
  const [scannerConnected, setScannerConnected] = useState(false);
  const [liveTradeFailure, setLiveTradeFailure] = useState<LiveTradeFailure | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/stream');

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
      } catch (_e) {}
    });

    es.addEventListener('stats', (e) => {
      try {
        const stats = JSON.parse(e.data) as BotStats;
        queryClient.setQueryData(getGetStatsQueryKey(), stats);
        setScannerConnected(stats.scannerConnected);
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
      } catch (_e) {}
    });

    return () => {
      es.close();
    };
  }, [queryClient]);

  return { scannerConnected, liveTradeFailure, dismissFailure: () => setLiveTradeFailure(null) };
}
