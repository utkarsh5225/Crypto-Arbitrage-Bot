import React, { useState, useEffect, useCallback } from 'react';
import {
  useGetStats,
  useGetConfig,
  useUpdateConfig,
  useGetOpportunities,
  useGetTrades,
  useGetCredentials,
  useSetCredentials,
  useKillBot,
  useGetAccountBalances,
  useGetAccountOrders,
  getGetOpportunitiesQueryKey,
  getGetTradesQueryKey,
  getGetStatsQueryKey,
  getGetConfigQueryKey,
  getGetCredentialsQueryKey,
  getGetAccountBalancesQueryKey,
  getGetAccountOrdersQueryKey,
} from '@workspace/api-client-react';
import type { TopOpportunity, AccountBalance, LiveOrder } from '@workspace/api-client-react';
import { useBotStream } from '@/hooks/use-bot-stream';
import { formatPercent, formatUsd, formatUptime, cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ValueFlash } from '@/components/ValueFlash';
import { PerformanceCharts } from '@/components/PerformanceCharts';
import { useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity, Zap, Settings2, BarChart2, TrendingUp, Trophy,
  ShieldAlert, Key, Wallet, ClipboardList, Power, Eye, EyeOff, AlertTriangle,
  Bell, BellOff, ChevronRight, ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';

export default function Dashboard() {
  const queryClient = useQueryClient();
  const {
    scannerConnected,
    liveTradeFailure,
    dismissFailure,
    connectionState,
    lastStatsAt,
    history,
    alertsEnabled,
    toggleAlerts,
  } = useBotStream();

  // ── Server data ────────────────────────────────────────────────────────────
  const { data: stats } = useGetStats({ query: { queryKey: getGetStatsQueryKey() } });
  const { data: config, refetch: refetchConfig } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const { data: opportunitiesResponse } = useGetOpportunities({ limit: 50 }, { query: { queryKey: getGetOpportunitiesQueryKey({ limit: 50 }) } });
  const { data: tradesResponse } = useGetTrades({ limit: 50 }, { query: { queryKey: getGetTradesQueryKey({ limit: 50 }) } });
  const { data: credStatus, refetch: refetchCreds } = useGetCredentials({ query: { queryKey: getGetCredentialsQueryKey() } });

  const isLive = stats?.tradingMode === 'live';
  const credentialsConfigured = credStatus?.configured ?? false;
  const useTestnet = config?.useTestnet ?? false;

  // Ticking clock so the "updated Xs ago" freshness indicator stays live.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsSinceUpdate = lastStatsAt ? Math.max(0, Math.floor((now - lastStatsAt) / 1000)) : null;
  // Stats broadcast every ~2s; flag stale if we've heard nothing for 8s.
  const dataStale = secondsSinceUpdate !== null && secondsSinceUpdate > 8;

  // Account data (live mode only)
  const { data: balancesData, refetch: refetchBalances } = useGetAccountBalances({
    query: { queryKey: getGetAccountBalancesQueryKey(), enabled: isLive, refetchInterval: 30_000, retry: false },
  });
  const { data: ordersData, refetch: refetchOrders } = useGetAccountOrders({
    query: { queryKey: getGetAccountOrdersQueryKey(), enabled: isLive, refetchInterval: 10_000, retry: false },
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const updateConfig = useUpdateConfig();
  const setCredentialsMutation = useSetCredentials();
  const killBotMutation = useKillBot();

  // ── Algorithm config local state ───────────────────────────────────────────
  const [feeRate, setFeeRate] = useState('');
  const [minProfitThreshold, setMinProfitThreshold] = useState('');
  const [notionalSize, setNotionalSize] = useState('');
  const [maxNotional, setMaxNotional] = useState('');
  const [dailyLossLimit, setDailyLossLimit] = useState('');
  const [maxSlippage, setMaxSlippage] = useState('');
  const [llmInterval, setLlmInterval] = useState('');
  const [llmMaxTrades, setLlmMaxTrades] = useState('');

  useEffect(() => {
    if (config) {
      setFeeRate((config.feeRate * 100).toString());
      setMinProfitThreshold((config.minProfitThreshold * 100).toString());
      setNotionalSize(config.notionalSize.toString());
      setMaxNotional(config.maxNotionalPerTrade.toString());
      setDailyLossLimit(config.dailyLossLimitUsd.toString());
      setMaxSlippage(((config.maxSlippagePct ?? 0) * 100).toString());
      setLlmInterval(String((config as any).llmIntervalSec ?? 60));
      setLlmMaxTrades(String((config as any).llmMaxTradesPerDay ?? 200));
    }
  }, [config]);

  const handleToggleCostAware = () => {
    const next = !(config as any)?.llmCostAware;
    updateConfig.mutate({ data: { llmCostAware: next } } as any, {
      onSuccess: () => {
        toast.success(next
          ? 'Cost-aware prompt — it will mostly decline 1m setups'
          : 'Naive prompt — it will trade freely');
        refetchConfig();
      },
      onError: (err: any) => toast.error(err?.message ?? 'Could not change prompt mode'),
    });
  };

  // ── Credentials local state ────────────────────────────────────────────────
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiSecretInput, setApiSecretInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showApiSecret, setShowApiSecret] = useState(false);
  const [serverIp, setServerIp] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/my-ip').then(r => r.json()).then(d => setServerIp(d.ip)).catch(() => {});
  }, []);

  // ── DeepSeek (LLM) API key ─────────────────────────────────────────────────
  // Raw fetch: these endpoints are not in the generated api-client. The key is
  // sent once and never read back — the server only ever returns a masked form.
  const [llmKeyInput, setLlmKeyInput] = useState('');
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmStatus, setLlmStatus] = useState<{ configured: boolean; maskedKey?: string; model?: string }>({ configured: false });

  const refetchLlm = useCallback(() => {
    fetch('/api/config/llm').then(r => r.json()).then(setLlmStatus).catch(() => {});
  }, []);
  useEffect(() => { refetchLlm(); }, [refetchLlm]);

  const handleSaveLlmKey = () => {
    setLlmSaving(true);
    fetch('/api/config/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: llmKeyInput.trim() }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Validation failed');
        toast.success(`DeepSeek key validated and saved (${d.maskedKey})`);
        setLlmKeyInput('');          // never keep the secret in component state
        refetchLlm();
      })
      .catch((err) => toast.error(err?.message ?? 'Could not save DeepSeek key'))
      .finally(() => setLlmSaving(false));
  };

  const handleClearLlmKey = () => {
    fetch('/api/config/llm', { method: 'DELETE' })
      .then(() => { toast.success('DeepSeek key removed'); refetchLlm(); })
      .catch(() => toast.error('Could not remove key'));
  };

  // ── LLM paper-trading scoreboard ───────────────────────────────────────────
  const [llmStats, setLlmStats] = useState<any>(null);
  const [llmTrades, setLlmTrades] = useState<any[]>([]);

  const [llmOpen, setLlmOpen] = useState<any[]>([]);
  const [llmPending, setLlmPending] = useState<any[]>([]);

  useEffect(() => {
    const pull = () => {
      fetch('/api/llm/stats').then(r => r.json()).then(setLlmStats).catch(() => {});
      fetch('/api/llm/trades?limit=12').then(r => r.json())
        .then(d => setLlmTrades(d.data ?? [])).catch(() => {});
    };
    const pullOpen = () => {
      fetch('/api/llm/open').then(r => r.json())
        .then(d => { setLlmOpen(d.open ?? []); setLlmPending(d.pending ?? []); })
        .catch(() => {});
    };
    pull(); pullOpen();
    const h = setInterval(pull, 10000);
    // Open positions carry the live mark, so refresh them more often.
    const ho = setInterval(pullOpen, 3000);
    return () => { clearInterval(h); clearInterval(ho); };
  }, []);

  const llmEnabled = !!config?.llmEnabled;
  const handleToggleLlm = () => {
    updateConfig.mutate({ data: { llmEnabled: !llmEnabled } } as any, {
      onSuccess: () => {
        toast.success(!llmEnabled ? 'DeepSeek loop ENABLED (paper)' : 'DeepSeek loop stopped');
        refetchConfig();
      },
      onError: (err: any) => toast.error(err?.message ?? 'Could not toggle'),
    });
  };

  // ── Symbol pool: the bot picks its own coins, the operator sets the slots ──
  const [picks, setPicks] = useState<any[]>([]);
  const [picking, setPicking] = useState(false);
  const [picksAt, setPicksAt] = useState(0);

  const autoPick = config?.llmAutoPick !== false;
  const maxConcurrent = config?.llmMaxConcurrent ?? 2;
  const repickMinutes = config?.llmRepickMinutes ?? 15;

  useEffect(() => {
    const loadPicks = () => {
      fetch('/api/llm/picks').then(r => r.json()).then(d => {
        setPicks(d.picks ?? []);
        setPicksAt(d.at ?? 0);
      }).catch(() => {});
    };
    loadPicks();
    // The bot rebuilds this pool on its own schedule, so poll it rather than
    // letting the screen claim a shortlist the bot has already replaced.
    const h = setInterval(loadPicks, 15000);
    return () => clearInterval(h);
  }, []);

  const setConcurrency = (n: number) => {
    if (n < 1 || n > 10) return;
    updateConfig.mutate({ data: { llmMaxConcurrent: n } } as any, {
      onSuccess: () => {
        toast.success(`Holding up to ${n} coin${n > 1 ? 's' : ''} at once`);
        refetchConfig();
      },
      onError: (err: any) => toast.error(err?.message ?? 'Could not save'),
    });
  };

  const handleRefreshPool = () => {
    setPicking(true);
    fetch('/api/llm/suggest', { method: 'POST' })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed');
        setPicks(d.picks ?? []);
        setPicksAt(d.at ?? Date.now());
        toast.success(`Shortlist refreshed — ${d.picks.length} candidates (${d.ms}ms)`);
      })
      .catch(e => toast.error(e?.message ?? 'Could not refresh shortlist'))
      .finally(() => setPicking(false));
  };

  // ── Discuss a trade with DeepSeek ─────────────────────────────────────────
  const [discussId, setDiscussId] = useState<string | null>(null);
  const [thread, setThread] = useState<any[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);

  const openDiscussion = (id: string) => {
    setDiscussId(id);
    setThread([]);
    fetch(`/api/llm/discuss/${id}`).then(r => r.json())
      .then(d => setThread(d.thread ?? [])).catch(() => {});
  };

  const askQuestion = () => {
    if (!discussId || !question.trim()) return;
    setAsking(true);
    fetch('/api/llm/discuss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tradeId: discussId, question: question.trim() }),
    })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed');
        setThread(d.thread ?? []);
        setQuestion('');
      })
      .catch(e => toast.error(e?.message ?? 'DeepSeek did not respond'))
      .finally(() => setAsking(false));
  };

  // ── Live mode confirmation modal ───────────────────────────────────────────
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);

  // ── Trade Log drill-down (expanded row ids) ────────────────────────────────
  const [expandedTrades, setExpandedTrades] = useState<Set<string>>(new Set());
  const toggleTradeExpanded = (id: string) =>
    setExpandedTrades((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleSaveConfig = () => {
    updateConfig.mutate({
      data: {
        maxNotionalPerTrade: parseFloat(maxNotional),
        dailyLossLimitUsd: parseFloat(dailyLossLimit),
        llmIntervalSec: parseInt(llmInterval, 10),
        llmMaxTradesPerDay: parseInt(llmMaxTrades, 10),
      } as any,
    }, {
      onSuccess: () => toast.success('Configuration updated'),
      onError: (err) => toast.error('Failed to update config: ' + err.message),
    });
  };

  const handleSaveCredentials = () => {
    if (!apiKeyInput.trim() || !apiSecretInput.trim()) {
      toast.error('Both API Key and Secret are required');
      return;
    }
    setCredentialsMutation.mutate(
      { data: { apiKey: apiKeyInput.trim(), apiSecret: apiSecretInput.trim() } },
      {
        onSuccess: () => {
          toast.success('Credentials saved and validated ✓');
          setApiKeyInput('');
          setApiSecretInput('');
          refetchCreds();
        },
        onError: (err) => toast.error('Credentials rejected: ' + err.message),
      },
    );
  };

  const handleToggleLiveMode = () => {
    if (isLive) {
      // Switching back to paper — no confirmation needed
      updateConfig.mutate({ data: { tradingMode: 'paper' } }, {
        onSuccess: () => {
          toast.success('Switched to Paper mode');
          refetchConfig();
        },
        onError: (err) => toast.error(err.message),
      });
    } else {
      if (!credentialsConfigured) {
        toast.error('Configure Binance credentials before enabling Live mode');
        return;
      }
      setShowLiveConfirm(true);
    }
  };

  const handleConfirmLive = () => {
    setShowLiveConfirm(false);
    updateConfig.mutate({ data: { tradingMode: 'live' } }, {
      onSuccess: () => {
        toast.success('Live trading ENABLED ⚡');
        refetchConfig();
        refetchBalances();
        refetchOrders();
      },
      onError: (err) => toast.error('Cannot enable live mode: ' + err.message),
    });
  };

  const handleToggleTestnet = () => {
    if (isLive) {
      toast.error('Switch to Paper mode before changing the network');
      return;
    }
    const next = !useTestnet;
    updateConfig.mutate({ data: { useTestnet: next } }, {
      onSuccess: () => {
        toast.success(next
          ? 'Testnet enabled — save your testnet.binance.vision API keys'
          : 'Switched to Production network');
        refetchConfig();
        refetchCreds();
      },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleKillSwitch = () => {
    killBotMutation.mutate({} as any, {
      onSuccess: () => {
        toast.success('Kill switch activated — reverted to Paper mode');
        refetchConfig();
      },
      onError: (err) => toast.error(err.message),
    });
  };

  // Zero the accumulated daily-loss counter (raw fetch — this endpoint is not in
  // the generated client). Clears a stale loss that keeps reverting Live to Paper.
  const handleResetDailyLoss = () => {
    fetch('/api/bot/reset-daily-loss', { method: 'POST' })
      .then((r) => r.json())
      .then((d: { previousDailyLossUsd?: number }) => {
        toast.success(`Daily-loss counter reset (was $${(d.previousDailyLossUsd ?? 0).toFixed(2)})`);
        refetchConfig();
      })
      .catch((err) => toast.error(err?.message ?? 'Failed to reset daily-loss counter'));
  };

  const opportunities = opportunitiesResponse?.data ?? [];
  const trades = tradesResponse?.data ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground p-4 lg:p-6 flex flex-col gap-6 font-mono selection:bg-primary/30">

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary flex items-center gap-2">
            <Zap className="h-6 w-6 fill-primary/20" />
            TRI-ARB TERMINAL <span className="text-muted-foreground text-sm font-normal">v0.1.0</span>
          </h1>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* PAPER / LIVE toggle */}
          <div className="flex items-center gap-1 border border-border rounded-md overflow-hidden">
            <button
              onClick={() => isLive && handleToggleLiveMode()}
              className={cn(
                'px-3 py-1.5 text-xs font-bold uppercase tracking-widest transition-colors',
                !isLive ? 'bg-muted text-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              Paper
            </button>
            <button
              onClick={() => !isLive && handleToggleLiveMode()}
              disabled={!credentialsConfigured && !isLive}
              title={!credentialsConfigured ? 'Configure API credentials first' : undefined}
              className={cn(
                'px-3 py-1.5 text-xs font-bold uppercase tracking-widest transition-colors',
                isLive
                  ? 'bg-amber-500 text-black'
                  : credentialsConfigured
                    ? 'bg-transparent text-muted-foreground hover:text-amber-400'
                    : 'bg-transparent text-muted-foreground/40 cursor-not-allowed',
              )}
            >
              ⚡ Live
            </button>
          </div>

          {/* Kill switch — only visible in live mode */}
          {isLive && (
            <Button
              size="sm"
              variant="destructive"
              onClick={handleKillSwitch}
              disabled={killBotMutation.isPending}
              className="h-8 gap-1.5 font-bold uppercase tracking-wider text-xs animate-pulse"
            >
              <Power className="h-3.5 w-3.5" />
              Kill Switch
            </Button>
          )}

          {/* Alerts toggle — browser notification + sound on live fills/failures */}
          <button
            onClick={toggleAlerts}
            title={alertsEnabled ? 'Alerts on (click to mute)' : 'Enable notification + sound alerts'}
            className={cn(
              'h-8 w-8 flex items-center justify-center rounded-md border transition-colors',
              alertsEnabled
                ? 'border-primary/40 text-primary bg-primary/10'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {alertsEnabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
          </button>

          {/* DeepSeek loop status */}
          <div className="flex items-center gap-3 sm:gap-4 border border-border bg-card px-3 sm:px-4 py-2 rounded-md shadow-sm">
            <div className="flex items-center gap-2 pr-3 sm:pr-4 border-r border-border">
              <div className={cn('h-2.5 w-2.5 rounded-full', llmEnabled ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground')} />
              <span className="text-sm uppercase tracking-widest text-muted-foreground hidden sm:inline">DeepSeek</span>
              <Badge variant={llmEnabled ? 'success' : 'outline'} className="ml-1">
                {llmEnabled ? 'Running' : 'Stopped'}
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <div className="flex flex-col">
                <span className="text-[10px] text-muted-foreground uppercase leading-none">Uptime</span>
                <ValueFlash value={formatUptime(stats?.uptimeSeconds)} className="font-medium" />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-muted-foreground uppercase leading-none">Holding</span>
                {/* What is actually held, not the whole shortlist — the pool is
                    deliberately larger than the slots, so listing it here would
                    overstate the exposure. */}
                <span className="font-medium text-xs">
                  {llmOpen.length > 0
                    ? <>{llmOpen.map((o: any) => o.symbol).join(' · ')}
                        <span className="text-muted-foreground"> ({llmOpen.length}/{maxConcurrent})</span></>
                    : <span className="text-muted-foreground">0/{maxConcurrent} — flat</span>}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-muted-foreground uppercase leading-none">Feed</span>
                <span
                  className={cn(
                    'font-medium text-xs',
                    connectionState === 'reconnecting' || dataStale
                      ? 'text-amber-400'
                      : 'text-muted-foreground',
                  )}
                >
                  {connectionState === 'reconnecting'
                    ? 'reconnecting…'
                    : secondsSinceUpdate === null
                      ? 'connecting…'
                      : dataStale
                        ? `stale ${secondsSinceUpdate}s`
                        : `${secondsSinceUpdate}s ago`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ── Persistent LIVE banner ───────────────────────────────────────────── */}
      {isLive && (
        <div
          className={cn(
            'flex items-center justify-center gap-2 rounded-md px-4 py-2 text-xs font-bold uppercase tracking-widest border',
            useTestnet
              ? 'bg-sky-500/10 border-sky-500/40 text-sky-300'
              : 'bg-amber-500/10 border-amber-500/50 text-amber-300 animate-pulse',
          )}
        >
          {useTestnet ? '🧪 Live · Testnet — fake funds' : '⚡ Live · Production — real money at risk'}
        </div>
      )}

      {/* ── Live Trade Failure Banner ────────────────────────────────────────── */}
      {liveTradeFailure && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/60 bg-destructive/10 px-4 py-3 text-sm text-destructive animate-in slide-in-from-top-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-bold uppercase tracking-wider text-xs mb-0.5">Live Trade Failed</p>
            <p className="text-xs text-muted-foreground">
              Path: <span className="font-mono text-foreground">{liveTradeFailure.path.join(' → ')}</span>
              {liveTradeFailure.failedLeg > 0 && (
                <> · Leg <span className="font-bold">{liveTradeFailure.failedLeg}</span></>
              )}
              {' · '}{liveTradeFailure.error}
            </p>
          </div>
          <button onClick={dismissFailure} className="shrink-0 text-muted-foreground hover:text-foreground leading-none text-lg font-bold">×</button>
        </div>
      )}

      {/* ── Stats Strip ──────────────────────────────────────────────────────── */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-5">
        <StatCard
          label="Open Signals"
          value={llmOpen.length}
          valueClass={llmOpen.length > 0 ? 'text-primary' : 'text-muted-foreground'}
          sublabel={llmOpen.length > 0
            ? llmOpen.map((o: any) => o.symbol).join(', ')
            : llmPending.length > 0 ? `${llmPending.length} limit${llmPending.length > 1 ? 's' : ''} waiting to fill` : 'waiting for a call'}
        />
        <StatCard
          label="Closed Trades"
          value={llmStats?.trades ?? 0}
          sublabel={(llmStats?.trades ?? 0) > 0
            ? `Win ${((llmStats?.winRate ?? 0) * 100).toFixed(0)}% · ${llmStats?.skips ?? 0} flat`
            : `${llmStats?.skips ?? 0} flat calls`}
        />
        <StatCard
          label="Avg Net / Trade"
          value={`${(llmStats?.avgNetBps ?? 0).toFixed(1)} bps`}
          valueClass={(llmStats?.avgNetBps ?? 0) > 0 ? 'text-green-400' : 'text-destructive'}
          sublabel={`avg cost ${(llmStats?.avgCostBps ?? 10).toFixed(1)} bps (maker-aware)`}
        />
        <StatCard
          label="Edge vs Random"
          value={`${(llmStats?.edgeVsRandom ?? 0) >= 0 ? '+' : ''}${(llmStats?.edgeVsRandom ?? 0).toFixed(1)} bps`}
          valueClass={(llmStats?.edgeVsRandom ?? 0) > 0 ? 'text-green-400' : 'text-destructive'}
          sublabel={(llmStats?.trades ?? 0) < 100
            ? `only ${llmStats?.trades ?? 0}/100 trades — noise`
            : 'sample is meaningful'}
        />
        <StatCard
          label="Model Latency"
          value={`${llmStats?.avgLatencyMs ?? 0} ms`}
          sublabel={`${llmStats?.calls ?? 0} calls made`}
        />
      </div>


      {/* ── Main Grid ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1 min-h-0">

        {/* Right Column */}
        <div className="lg:col-span-2 flex flex-col gap-6">

          {/* Config Card */}
          <Card className="shrink-0 bg-card border-border">
            <CardHeader className="py-3">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Configuration</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-5 pt-2">

              {/* DeepSeek loop settings */}
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">DeepSeek Loop</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="llmInterval" className="text-xs">Decision Interval (s)</Label>
                    <Input
                      id="llmInterval" type="number" step="30" min="30"
                      value={llmInterval} onChange={e => setLlmInterval(e.target.value)}
                      className="bg-background/50 h-8 text-xs"
                    />
                    <p className="text-[9px] text-muted-foreground">60 = 1-minute cadence. Restart applies it.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="llmMaxTrades" className="text-xs">Max Trades / Day</Label>
                    <Input
                      id="llmMaxTrades" type="number" step="10" min="1"
                      value={llmMaxTrades} onChange={e => setLlmMaxTrades(e.target.value)}
                      className="bg-background/50 h-8 text-xs"
                    />
                    <p className="text-[9px] text-muted-foreground">Caps how much a chatty model can trade.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Prompt Mode</Label>
                    <Button
                      onClick={handleToggleCostAware}
                      size="sm" variant="outline"
                      className="h-8 w-full text-[11px] font-bold"
                    >
                      {config?.llmCostAware ? 'Cost-aware' : 'Naive (trades freely)'}
                    </Button>
                    <p className="text-[9px] text-muted-foreground">
                      {config?.llmCostAware
                        ? 'Tells it the 10 bps cost — it will decline most 1m setups.'
                        : 'No cost constraint — it trades, which is what generates data.'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Safety Controls */}
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                  <ShieldAlert className="h-3 w-3" /> Risk Limits
                  <span className="normal-case tracking-normal text-muted-foreground/70">
                    — apply when live futures execution is wired up
                  </span>
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="maxNotional" className="text-xs">Max Notional / Trade ($)</Label>
                    <Input id="maxNotional" value={maxNotional} onChange={e => setMaxNotional(e.target.value)} type="number" step="10" className="bg-background/50 h-8 text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="dailyLoss" className="text-xs">Daily Loss Limit ($)</Label>
                    <Input id="dailyLoss" value={dailyLossLimit} onChange={e => setDailyLossLimit(e.target.value)} type="number" step="5" className="bg-background/50 h-8 text-xs" />
                    <button
                      type="button"
                      onClick={handleResetDailyLoss}
                      title="Zero the accumulated daily-loss counter. Use if a stale loss keeps reverting Live to Paper."
                      className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground underline underline-offset-2"
                    >
                      Reset counter{(stats?.dailyLossUsd ?? 0) > 0 ? ` ($${(stats?.dailyLossUsd ?? 0).toFixed(2)})` : ''}
                    </button>
                  </div>
                  <div className="space-y-1.5">
                  </div>
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveConfig} disabled={updateConfig.isPending} size="sm" className="bg-primary text-background hover:bg-primary/80 font-bold text-xs">
                  {updateConfig.isPending ? 'Saving...' : 'Apply Config'}
                </Button>
              </div>

              {/* Credentials */}
              <div className="border-t border-border pt-4">
                {/* Network selector: Production vs Testnet */}
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Network
                  </p>
                  <div className="flex items-center gap-1 border border-border rounded-md overflow-hidden">
                    <button
                      onClick={() => useTestnet && handleToggleTestnet()}
                      disabled={isLive}
                      title={isLive ? 'Switch to Paper mode to change network' : undefined}
                      className={cn(
                        'px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors',
                        !useTestnet ? 'bg-primary text-background' : 'bg-transparent text-muted-foreground hover:text-foreground',
                        isLive && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      Production
                    </button>
                    <button
                      onClick={() => !useTestnet && handleToggleTestnet()}
                      disabled={isLive}
                      title={isLive ? 'Switch to Paper mode to change network' : undefined}
                      className={cn(
                        'px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors',
                        useTestnet ? 'bg-sky-500 text-black' : 'bg-transparent text-muted-foreground hover:text-sky-400',
                        isLive && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      🧪 Testnet
                    </button>
                  </div>
                </div>
                {useTestnet && (
                  <div className="mb-2 text-[10px] text-sky-400/90 bg-sky-500/10 rounded px-2 py-1.5 space-y-1">
                    <p>
                      Testnet uses separate API keys from{' '}
                      <code className="select-all">testnet.binance.vision</code> and fake funds — safe for validating live execution.
                    </p>
                    <p className="text-sky-400/70">
                      Note: opportunities are still detected from live mainnet prices, but fills use testnet's thin books — P&amp;L here reflects plumbing, not real market rates.
                    </p>
                  </div>
                )}
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Key className="h-3 w-3" /> Binance API Credentials
                  </p>
                  {credentialsConfigured
                    ? <span className="text-[10px] text-green-400 font-mono">✓ {credStatus?.maskedKey}</span>
                    : <span className="text-[10px] text-destructive">✗ Not configured</span>
                  }
                </div>
                {serverIp && (
                  <div className="mb-2 flex items-center gap-1.5 text-[10px] text-muted-foreground bg-muted/30 rounded px-2 py-1.5">
                    <span className="shrink-0">Whitelist this IP in Binance:</span>
                    <code className="text-amber-400 font-bold select-all">{serverIp}</code>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-2">
                  <div className="relative">
                    <Input
                      placeholder="API Key"
                      value={apiKeyInput}
                      onChange={e => setApiKeyInput(e.target.value)}
                      type={showApiKey ? 'text' : 'password'}
                      className="bg-background/50 h-8 text-xs pr-8 font-mono"
                    />
                    <button onClick={() => setShowApiKey(v => !v)} className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground">
                      {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  <div className="relative">
                    <Input
                      placeholder="API Secret"
                      value={apiSecretInput}
                      onChange={e => setApiSecretInput(e.target.value)}
                      type={showApiSecret ? 'text' : 'password'}
                      className="bg-background/50 h-8 text-xs pr-8 font-mono"
                    />
                    <button onClick={() => setShowApiSecret(v => !v)} className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground">
                      {showApiSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  <Button
                    onClick={handleSaveCredentials}
                    disabled={setCredentialsMutation.isPending || !apiKeyInput || !apiSecretInput}
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs font-bold"
                  >
                    {setCredentialsMutation.isPending ? 'Validating...' : 'Save & Validate'}
                  </Button>
                </div>
              </div>

              {/* DeepSeek (LLM) API key */}
              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Key className="h-3 w-3" /> DeepSeek API Key
                  </p>
                  {llmStatus.configured
                    ? <span className="text-[10px] text-green-400 font-mono">✓ {llmStatus.maskedKey}</span>
                    : <span className="text-[10px] text-muted-foreground">Not configured</span>
                  }
                </div>
                <div className="mb-2 text-[10px] text-muted-foreground bg-muted/30 rounded px-2 py-1.5 leading-relaxed">
                  Stored encrypted (AES-256-GCM), never logged, never returned in full.
                  Validated against DeepSeek on save.
                </div>
                <div className="grid grid-cols-1 gap-2">
                  <div className="relative">
                    <Input
                      placeholder="sk-..."
                      value={llmKeyInput}
                      onChange={e => setLlmKeyInput(e.target.value)}
                      type={showLlmKey ? 'text' : 'password'}
                      className="bg-background/50 h-8 text-xs pr-8 font-mono"
                    />
                    <button onClick={() => setShowLlmKey(v => !v)} className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground">
                      {showLlmKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleSaveLlmKey}
                      disabled={llmSaving || !llmKeyInput.trim()}
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs font-bold flex-1"
                    >
                      {llmSaving ? 'Validating...' : 'Save & Validate'}
                    </Button>
                    {llmStatus.configured && (
                      <Button
                        onClick={handleClearLlmKey}
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs text-destructive hover:text-destructive"
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                  {llmStatus.configured && (
                    <Button
                      onClick={handleToggleLlm}
                      size="sm"
                      variant={llmEnabled ? 'destructive' : 'outline'}
                      className="h-8 text-xs font-bold"
                    >
                      {llmEnabled ? 'Stop DeepSeek Loop' : 'Start DeepSeek Loop (Paper)'}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── DeepSeek paper-trading scoreboard ─────────────────────────────────── */}
      {llmStatus.configured && (
        <Card>
          <CardHeader className="py-3 flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <CardTitle>DeepSeek Scalper — Paper</CardTitle>
            </div>
            <Badge variant="outline" className={cn('text-[10px]', llmEnabled ? 'text-green-400' : 'text-muted-foreground')}>
              {llmEnabled ? 'RUNNING' : 'STOPPED'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Step 1 — the bot picks its own coins; you set how many it may hold */}
            <div className="rounded-md border border-border p-3 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold">1 · How many coins at once?</p>
                  <p className="text-[10px] text-muted-foreground leading-snug">
                    You set the slots — the bot decides which coins fill them and
                    refreshes its shortlist every {repickMinutes} min.
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    onClick={() => setConcurrency(maxConcurrent - 1)}
                    disabled={maxConcurrent <= 1 || updateConfig.isPending}
                    size="sm" variant="outline" className="h-8 w-8 p-0 text-base font-bold"
                  >−</Button>
                  <div className="w-10 text-center text-xl font-bold tabular-nums">{maxConcurrent}</div>
                  <Button
                    onClick={() => setConcurrency(maxConcurrent + 1)}
                    disabled={maxConcurrent >= 10 || updateConfig.isPending}
                    size="sm" variant="outline" className="h-8 w-8 p-0 text-base font-bold"
                  >+</Button>
                </div>
              </div>

              {/* Slot usage — filled vs free, at a glance */}
              <div className="flex items-center gap-1.5">
                {Array.from({ length: maxConcurrent }).map((_, i) => {
                  const pos = llmOpen[i];
                  return (
                    <div
                      key={i}
                      className={cn(
                        'flex-1 rounded border px-2 py-1.5 text-center',
                        pos ? 'border-primary bg-primary/10' : 'border-dashed border-border',
                      )}
                    >
                      {pos ? (
                        <>
                          <div className="text-[10px] font-bold truncate">{pos.symbol}</div>
                          <div className={cn('text-[9px] font-mono',
                            pos.side === 'long' ? 'text-green-400' : 'text-red-400')}>
                            {pos.side}
                          </div>
                        </>
                      ) : (
                        <div className="text-[10px] text-muted-foreground">empty</div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* The shortlist the bot is choosing from */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-bold text-muted-foreground">
                    SHORTLIST{picksAt ? ` · updated ${new Date(picksAt).toLocaleTimeString()}` : ''}
                  </p>
                  <Button
                    onClick={handleRefreshPool} disabled={picking}
                    size="sm" variant="outline" className="h-6 text-[10px]"
                  >
                    {picking ? 'Asking...' : 'Refresh now'}
                  </Button>
                </div>
                {picks.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {picks.map((p) => {
                      const held = llmOpen.some((o: any) => o.symbol === p.symbol);
                      return (
                        <div
                          key={p.symbol}
                          className={cn(
                            'rounded-md border p-2',
                            held ? 'border-primary bg-primary/10' : 'border-border',
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold">{p.symbol}</span>
                            {held
                              ? <span className="text-[9px] font-bold text-primary">HELD</span>
                              : <span className="text-[10px] font-mono text-muted-foreground">
                                  {(p.confidence * 100).toFixed(0)}%
                                </span>}
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{p.reason}</p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground">
                    {llmEnabled
                      ? 'Building the shortlist on the next tick...'
                      : 'Start the loop and the bot will build its own shortlist.'}
                  </p>
                )}
              </div>

              <Button
                onClick={handleToggleLlm}
                size="sm"
                variant={llmEnabled ? 'destructive' : 'default'}
                className={cn('w-full h-8 text-xs font-bold',
                  !llmEnabled && 'bg-primary text-background hover:bg-primary/80')}
              >
                {llmEnabled
                  ? 'Stop trading'
                  : `Start trading — up to ${maxConcurrent} coin${maxConcurrent > 1 ? 's' : ''} (Paper)`}
              </Button>

              <p className="text-[10px] text-muted-foreground leading-snug">
                Confidence is the model's own claim about itself — recorded, never trusted.
                {!autoPick && ' Auto-pick is OFF: the bot is trading a fixed manual list.'}
              </p>
            </div>

            {/* PENDING ENTRIES — maker limits waiting to fill */}
            {llmPending.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
                <p className="text-xs font-bold text-amber-400">
                  WAITING FOR FILL — resting limit orders (maker)
                </p>
                {llmPending.map((q: any) => (
                  <div key={`${q.symbol}-${q.placedAt}`} className="rounded border border-border bg-background/60 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-bold',
                        q.side === 'long' ? 'bg-green-500/20 text-green-400' : 'bg-destructive/20 text-destructive')}>
                        {String(q.side).toUpperCase()}
                      </span>
                      <span className="font-bold">{q.symbol}</span>
                      {q.setup && <span className="text-[9px] uppercase text-muted-foreground">{q.setup}</span>}
                      <span className="font-mono">limit {Number(q.limit).toPrecision(6)}</span>
                      <div className="flex-1" />
                      <span className="text-[10px] text-muted-foreground">
                        waiting {q.barsWaiting} bar{q.barsWaiting === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1 italic">"{q.reason}"</p>
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground">
                  A limit that does not fill within {config?.llmMakerFillTimeoutBars ?? 3} bars is cancelled —
                  but still tracked, so we learn what the unfilled trades would have done.
                </p>
              </div>
            )}

            {/* ACTIVE SIGNALS — what the model wants traded right now */}
            <div className="rounded-md border-2 border-primary/50 bg-primary/5 p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-bold flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-primary" />
                  ACTIVE SIGNALS — take these trades
                </p>
                <Badge variant="outline" className="text-[10px]">{llmOpen.length} open</Badge>
              </div>

              {llmOpen.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {llmPending.length > 0
                    ? 'No filled position yet — entry limits below are waiting for the market to come to them.'
                    : 'No open signal right now. When DeepSeek makes a call it appears here with exact entry, stop and target.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {llmOpen.map((o) => (
                    <div key={o.id} className="rounded border border-border bg-background/60 p-2.5">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className={cn('px-2 py-0.5 rounded text-xs font-bold',
                          o.side === 'long' ? 'bg-green-500/20 text-green-400' : 'bg-destructive/20 text-destructive')}>
                          {String(o.side).toUpperCase()}
                        </span>
                        <span className="text-sm font-bold">{o.symbol}</span>
                        {o.setup && (
                          <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded uppercase',
                            o.setup === 'breakout' ? 'bg-green-500/15 text-green-400' : 'bg-destructive/15 text-destructive')}>
                            {o.setup}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {(() => {
                            const s = Math.max(0, Math.floor((now - o.openedAt) / 1000));
                            return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
                          })()} · conf {(o.confidence * 100).toFixed(0)}%
                        </span>
                        {o.riskReward != null && (
                          <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded',
                            o.riskReward >= 2 ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400')}>
                            R:R {Number(o.riskReward).toFixed(2)}
                          </span>
                        )}
                        <div className="flex-1" />
                        <span className={cn('text-sm font-bold font-mono',
                          o.unrealBps >= 0 ? 'text-green-400' : 'text-destructive')}>
                          {o.unrealBps >= 0 ? '+' : ''}{Number(o.unrealBps).toFixed(1)} bps
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                        <div>
                          <p className="text-[9px] uppercase text-muted-foreground">Entry</p>
                          <p className="font-bold">{Number(o.entry).toPrecision(6)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase text-muted-foreground">Stop loss</p>
                          <p className="font-bold text-destructive">{Number(o.stop).toPrecision(6)}</p>
                          <p className="text-[9px] text-muted-foreground">−{Number(o.stopBps).toFixed(0)} bps</p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase text-muted-foreground">Target</p>
                          <p className="font-bold text-green-400">{Number(o.target).toPrecision(6)}</p>
                          <p className="text-[9px] text-muted-foreground">+{Number(o.targetBps).toFixed(0)} bps</p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase text-muted-foreground">Now</p>
                          <p className="font-bold">{Number(o.lastPrice).toPrecision(6)}</p>
                        </div>
                      </div>

                      <p className="text-[10px] text-muted-foreground mt-2 italic">"{o.reason}"</p>
                      {o.lastReview && (
                        <p className="text-[10px] mt-1.5 text-primary/90">
                          <span className="uppercase tracking-wider text-muted-foreground">Latest review: </span>
                          {o.lastReview}
                        </p>
                      )}
                    </div>
                  ))}
                  <p className="text-[10px] text-muted-foreground">
                    Paper only — the bot is not placing these on the exchange. Copy the levels
                    manually if you want to act on one.
                  </p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">Trades</p>
                <p className="text-lg font-bold">{llmStats?.trades ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">{llmStats?.skips ?? 0} flat calls</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">Win rate</p>
                <p className="text-lg font-bold">{((llmStats?.winRate ?? 0) * 100).toFixed(1)}%</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">Avg net / trade</p>
                <p className={cn('text-lg font-bold', (llmStats?.avgNetBps ?? 0) > 0 ? 'text-green-400' : 'text-destructive')}>
                  {(llmStats?.avgNetBps ?? 0).toFixed(2)}<span className="text-xs"> bps</span>
                </p>
                <p className="text-[10px] text-muted-foreground">cost {llmStats?.roundTripCostBps ?? 10} bps</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">Coin-flip control</p>
                <p className="text-lg font-bold text-muted-foreground">
                  {(llmStats?.avgRandomNetBps ?? 0).toFixed(2)}<span className="text-xs"> bps</span>
                </p>
              </div>
            </div>

            {/* the number that decides it */}
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
              <div className="flex items-baseline justify-between">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Edge vs random (the only number that matters)
                </p>
                <p className={cn('text-xl font-bold',
                  (llmStats?.edgeVsRandom ?? 0) > 0 ? 'text-green-400' : 'text-destructive')}>
                  {(llmStats?.edgeVsRandom ?? 0) >= 0 ? '+' : ''}{(llmStats?.edgeVsRandom ?? 0).toFixed(2)} bps
                </p>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                DeepSeek's average result minus a same-instant coin flip using identical stop/target.
                Near zero = no edge, however confident the reasoning sounds. Needs ~100+ trades to mean anything.
              </p>
            </div>

            {/* MEASUREMENT — breakout split and maker-fill honesty */}
            {((llmStats?.entryFills ?? 0) + (llmStats?.entryNonFills ?? 0) > 0 ||
              (llmStats?.bySetup ?? []).some((b: any) => b.n > 0)) && (
              <div className="rounded-md border border-border p-3 space-y-2">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Measurement — is any of this actually working?
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                  {(llmStats?.bySetup ?? []).filter((b: any) => b.n > 0).map((b: any) => (
                    <div key={b.setup} className="rounded border border-border p-2">
                      <p className="text-[9px] uppercase text-muted-foreground">{b.setup} trades</p>
                      <p className={cn('font-bold font-mono',
                        b.avgNetBps > 0 ? 'text-green-400' : 'text-destructive')}>
                        {b.avgNetBps >= 0 ? '+' : ''}{Number(b.avgNetBps).toFixed(1)} bps
                      </p>
                      <p className="text-[9px] text-muted-foreground">
                        n={b.n} · win {(b.winRate * 100).toFixed(0)}%
                      </p>
                    </div>
                  ))}
                  {(llmStats?.entryFills ?? 0) + (llmStats?.entryNonFills ?? 0) > 0 && (
                    <div className="rounded border border-border p-2">
                      <p className="text-[9px] uppercase text-muted-foreground">Entry fill rate</p>
                      <p className="font-bold font-mono">
                        {((llmStats?.fillRate ?? 1) * 100).toFixed(0)}%
                      </p>
                      <p className="text-[9px] text-muted-foreground">
                        {llmStats?.entryNonFills ?? 0} missed
                        {(llmStats?.entryNonFills ?? 0) > 0 &&
                          ` · would've made ${(llmStats?.avgNonFillWouldBeBps ?? 0) >= 0 ? '+' : ''}${Number(llmStats?.avgNonFillWouldBeBps ?? 0).toFixed(1)} bps`}
                      </p>
                    </div>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  If the missed entries keep outperforming the filled ones, the maker fee saving
                  is an illusion (the market only fills you when the trade is going wrong) and
                  maker entry should be turned off.
                </p>
              </div>
            )}

            {llmTrades.length > 0 && (
              <div className="overflow-auto max-h-56">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[70px]">Side</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                      <TableHead className="text-right">Flip</TableHead>
                      <TableHead className="w-[60px]">Exit</TableHead>
                      <TableHead>Model reasoning</TableHead>
                      <TableHead className="w-[70px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {llmTrades.map((t) => (
                      <TableRow key={t.id} className="text-xs border-border/40">
                        <TableCell className={cn('font-bold', t.side === 'long' ? 'text-green-400' : 'text-destructive')}>
                          {String(t.side).toUpperCase()}
                        </TableCell>
                        <TableCell className={cn('text-right font-mono', t.netBps > 0 ? 'text-green-400' : 'text-destructive')}>
                          {t.netBps > 0 ? '+' : ''}{Number(t.netBps).toFixed(1)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">
                          {t.ctrlNetBps > 0 ? '+' : ''}{Number(t.ctrlNetBps).toFixed(1)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{t.how}</TableCell>
                        <TableCell className="text-muted-foreground truncate max-w-[220px]" title={t.reason}>
                          {t.reason}
                        </TableCell>
                        <TableCell>
                          <button
                            onClick={() => openDiscussion(t.id)}
                            className="text-[10px] uppercase tracking-wider text-primary hover:underline"
                          >
                            Discuss
                          </button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Discussion panel — interrogate a specific trade */}
            {discussId && (
              <div className="rounded-md border border-primary/40 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold">Discussing trade {discussId}</p>
                  <button onClick={() => setDiscussId(null)} className="text-[10px] text-muted-foreground hover:text-foreground">
                    close
                  </button>
                </div>
                <div className="max-h-52 overflow-auto space-y-2">
                  {thread.length === 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      Ask why it took this trade, whether the reasoning held up, or what it would do differently.
                    </p>
                  )}
                  {thread.map((m, i) => (
                    <div key={i} className={cn('text-xs rounded px-2 py-1.5',
                      m.role === 'user' ? 'bg-muted/40 text-foreground' : 'bg-primary/10 text-foreground')}>
                      <span className="text-[9px] uppercase tracking-wider text-muted-foreground block mb-0.5">
                        {m.role === 'user' ? 'You' : 'DeepSeek'}
                      </span>
                      <span className="whitespace-pre-wrap leading-relaxed">{m.content}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !asking) askQuestion(); }}
                    placeholder="Why did you take this trade?"
                    className="bg-background/50 h-8 text-xs"
                  />
                  <Button onClick={askQuestion} disabled={asking || !question.trim()} size="sm" variant="outline" className="h-8 text-xs">
                    {asking ? '...' : 'Ask'}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}


      {/* ── Live Mode Panels ──────────────────────────────────────────────────── */}
      {isLive && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <AccountBalancesPanel
            balances={balancesData?.balances ?? []}
            totalUsdtValue={balancesData?.totalUsdtValue ?? 0}
            updatedAt={balancesData?.updatedAt}
          />
          <OrderHistoryPanel orders={ordersData?.orders ?? []} />
        </div>
      )}

      {/* ── Live Mode Confirmation Modal ──────────────────────────────────────── */}
      {showLiveConfirm && (
        <LiveModeConfirmModal
          dailyLossLimit={config?.dailyLossLimitUsd ?? 50}
          maxNotional={config?.maxNotionalPerTrade ?? 1000}
          useTestnet={useTestnet}
          onConfirm={handleConfirmLive}
          onCancel={() => setShowLiveConfirm(false)}
        />
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StatCard({
  label, value, valueClass, sublabel,
}: {
  label: string;
  value: string | number;
  valueClass?: string;
  sublabel?: string;
}) {
  return (
    <Card className="bg-card overflow-hidden">
      <div className="p-4 flex flex-col justify-center h-full">
        <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</span>
        <div className={cn('text-xl md:text-2xl font-bold tracking-tight', valueClass)}>
          <ValueFlash value={value} type={typeof value === 'string' ? 'text' : 'number'} />
        </div>
        {sublabel && <span className="text-[10px] text-muted-foreground mt-0.5">{sublabel}</span>}
      </div>
    </Card>
  );
}

function formatRelativeTime(isoString: string) {
  try {
    return formatDistanceToNow(new Date(isoString), { addSuffix: true, includeSeconds: true })
      .replace('about ', '')
      .replace('less than a minute ago', 'just now');
  } catch { return isoString; }
}

function TopOpportunitiesCard({
  title, subtitle, icon, items, emptyMessage, highlight = false,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  items: TopOpportunity[];
  emptyMessage: string;
  highlight?: boolean;
}) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="py-3 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <CardTitle className="text-sm">{title}</CardTitle>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">{subtitle}</p>
          </div>
        </div>
        <Badge variant="outline" className="text-[10px] bg-background">Top 5</Badge>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10 border-b border-border">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-6 text-center text-muted-foreground pl-3">#</TableHead>
              <TableHead>Path</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right pr-4">Net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-20 text-center text-muted-foreground text-xs">{emptyMessage}</TableCell>
              </TableRow>
            ) : items.map((item, i) => {
              const isPositive = item.netProfitPct > 0;
              const rankColors = ['text-amber-400', 'text-slate-400', 'text-orange-700', 'text-muted-foreground', 'text-muted-foreground'];
              return (
                <TableRow key={item.path.join('/')} className="text-xs border-border/40">
                  <TableCell className={cn('pl-3 font-bold text-center', rankColors[i] ?? 'text-muted-foreground')}>{i + 1}</TableCell>
                  <TableCell className="font-medium tracking-tight">
                    <ValueFlash value={item.path.join(' → ')} type="text" />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground whitespace-nowrap">
                    <ValueFlash value={formatPercent(item.grossProfitPct)} type="number" />
                  </TableCell>
                  <TableCell className={cn('text-right font-bold pr-4 whitespace-nowrap', isPositive ? (highlight ? 'text-amber-400' : 'text-green-400') : 'text-muted-foreground')}>
                    <ValueFlash value={formatPercent(item.netProfitPct)} type="number" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AccountBalancesPanel({
  balances, totalUsdtValue, updatedAt,
}: {
  balances: AccountBalance[];
  totalUsdtValue: number;
  updatedAt?: string;
}) {
  return (
    <Card className="bg-card border-border border-amber-500/20">
      <CardHeader className="py-3 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-amber-400" />
          <div>
            <CardTitle className="text-sm">Account Balances</CardTitle>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
              Live · {updatedAt ? `Updated ${formatRelativeTime(updatedAt)}` : 'Loading...'}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground uppercase">Portfolio</div>
          <div className="text-sm font-bold text-amber-400">{formatUsd(totalUsdtValue)}</div>
        </div>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10 border-b border-border">
            <TableRow className="hover:bg-transparent">
              <TableHead>Asset</TableHead>
              <TableHead className="text-right">Free</TableHead>
              <TableHead className="text-right">Locked</TableHead>
              <TableHead className="text-right pr-4">≈ USDT</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {balances.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-16 text-center text-muted-foreground text-xs">
                  Loading balances...
                </TableCell>
              </TableRow>
            ) : balances.slice(0, 10).map((b) => (
              <TableRow key={b.asset} className="text-xs border-border/40">
                <TableCell className="font-bold text-amber-300">{b.asset}</TableCell>
                <TableCell className="text-right font-mono">
                  {b.free >= 0.0001 ? b.free.toFixed(b.free < 1 ? 6 : 4) : '<0.0001'}
                </TableCell>
                <TableCell className="text-right text-muted-foreground font-mono">
                  {b.locked > 0 ? b.locked.toFixed(4) : '—'}
                </TableCell>
                <TableCell className="text-right pr-4 text-muted-foreground">
                  {b.usdtValue !== undefined ? formatUsd(b.usdtValue) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OrderHistoryPanel({ orders }: { orders: LiveOrder[] }) {
  return (
    <Card className="bg-card border-border border-amber-500/20">
      <CardHeader className="py-3 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-amber-400" />
          <div>
            <CardTitle className="text-sm">Order History</CardTitle>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">Live bot-placed orders</p>
          </div>
        </div>
        <Badge variant="outline" className="text-[10px] bg-background">Last 20</Badge>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10 border-b border-border">
            <TableRow className="hover:bg-transparent">
              <TableHead>Symbol</TableHead>
              <TableHead className="text-center w-12">Leg</TableHead>
              <TableHead className="text-center w-12">Side</TableHead>
              <TableHead className="text-center w-16">Status</TableHead>
              <TableHead className="text-right pr-4">Avg Price</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-16 text-center text-muted-foreground text-xs">
                  No live orders placed yet.
                </TableCell>
              </TableRow>
            ) : orders.map((o) => {
              const isError = o.status === 'ERROR';
              return (
                <TableRow
                  key={`${o.orderId}-${o.leg}-${o.timestamp}`}
                  className={cn('text-xs border-border/40', isError && 'bg-destructive/5')}
                >
                  <TableCell className={cn('font-medium', isError && 'text-destructive')}>{o.symbol}</TableCell>
                  <TableCell className="text-center text-muted-foreground">{o.leg}</TableCell>
                  <TableCell className="text-center">
                    <Badge
                      className={cn('text-[8px] px-1 py-0 h-3.5', o.side === 'BUY' ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-red-500/20 text-red-400 border-red-500/30')}
                      variant="outline"
                    >
                      {o.side}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    {isError ? (
                      <Badge className="text-[8px] px-1 py-0 h-3.5 bg-destructive/20 text-destructive border-destructive/40" variant="outline">
                        ERROR
                      </Badge>
                    ) : (
                      <span className="text-[10px] text-muted-foreground font-mono">{o.status}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right pr-4 text-muted-foreground font-mono">
                    {isError ? <span className="text-destructive/60">—</span> : o.avgPrice.toFixed(4)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function LiveModeConfirmModal({
  dailyLossLimit, maxNotional, useTestnet, onConfirm, onCancel,
}: {
  dailyLossLimit: number;
  maxNotional: number;
  useTestnet: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-card border border-amber-500/50 rounded-xl shadow-2xl max-w-md w-full mx-4 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 rounded-full bg-amber-500/20 flex items-center justify-center">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h2 className="font-bold text-lg tracking-tight">Enable Live Trading</h2>
            <p className="text-xs text-muted-foreground">
              {useTestnet ? 'Testnet — no real money at risk' : 'Real money will be used'}
            </p>
          </div>
        </div>

        {useTestnet && (
          <div className="bg-sky-500/10 border border-sky-500/30 rounded-lg p-3 mb-4 text-xs text-sky-300">
            🧪 <span className="font-bold">Testnet mode</span> — orders route to testnet.binance.vision with fake funds. Great for validating the full execution path safely.
          </div>
        )}

        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4 mb-5 space-y-2 text-sm">
          <p className="text-amber-300 font-bold text-xs uppercase tracking-wider mb-2">You acknowledge that:</p>
          <ul className="space-y-1.5 text-muted-foreground text-xs">
            <li>⚡ {useTestnet ? 'Simulated' : 'Real'} market orders will fire on {useTestnet ? 'Binance Testnet' : 'your Binance account'}</li>
            <li>📦 Each triangle executes 3 sequential market orders</li>
            <li>🔁 A failed leg triggers a best-effort unwind back to USDT</li>
            <li>🚫 Triangles below Binance minimum notional are skipped</li>
            <li>🛡 Bot pauses at daily loss limit: <span className="text-foreground font-bold">{formatUsd(dailyLossLimit)}</span></li>
            <li>💰 Max notional per trade: <span className="text-foreground font-bold">{formatUsd(maxNotional)}</span></li>
            <li>🔴 Use the Kill Switch to stop immediately</li>
          </ul>
        </div>

        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={onCancel} className="font-bold">Cancel</Button>
          <Button
            onClick={onConfirm}
            className="bg-amber-500 text-black hover:bg-amber-400 font-bold"
          >
            ⚡ Enable Live Trading
          </Button>
        </div>
      </div>
    </div>
  );
}
