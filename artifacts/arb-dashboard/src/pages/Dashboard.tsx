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

  useEffect(() => {
    if (config) {
      setFeeRate((config.feeRate * 100).toString());
      setMinProfitThreshold((config.minProfitThreshold * 100).toString());
      setNotionalSize(config.notionalSize.toString());
      setMaxNotional(config.maxNotionalPerTrade.toString());
      setDailyLossLimit(config.dailyLossLimitUsd.toString());
      setMaxSlippage(((config.maxSlippagePct ?? 0) * 100).toString());
    }
  }, [config]);

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
        feeRate: parseFloat(feeRate) / 100,
        minProfitThreshold: parseFloat(minProfitThreshold) / 100,
        notionalSize: parseFloat(notionalSize),
        maxNotionalPerTrade: parseFloat(maxNotional),
        dailyLossLimitUsd: parseFloat(dailyLossLimit),
        maxSlippagePct: parseFloat(maxSlippage) / 100,
      },
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

          {/* Scanner status */}
          <div className="flex items-center gap-3 sm:gap-4 border border-border bg-card px-3 sm:px-4 py-2 rounded-md shadow-sm">
            <div className="flex items-center gap-2 pr-3 sm:pr-4 border-r border-border">
              <div className={cn('h-2.5 w-2.5 rounded-full animate-pulse', scannerConnected ? 'bg-green-500' : 'bg-destructive')} />
              <span className="text-sm uppercase tracking-widest text-muted-foreground hidden sm:inline">Scanner</span>
              <Badge variant={scannerConnected ? 'success' : 'destructive'} className="ml-1">
                {scannerConnected ? 'Live' : 'Offline'}
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <div className="flex flex-col">
                <span className="text-[10px] text-muted-foreground uppercase leading-none">Uptime</span>
                <ValueFlash value={formatUptime(stats?.uptimeSeconds)} className="font-medium" />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-muted-foreground uppercase leading-none">Pairs</span>
                <ValueFlash value={stats?.pairsTracked ?? 0} className="font-medium" />
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
      <div className={cn('grid gap-4', isLive ? 'grid-cols-2 md:grid-cols-6' : 'grid-cols-2 md:grid-cols-5')}>
        <StatCard
          label={isLive ? 'Live P&L' : 'Paper P&L'}
          value={formatUsd(isLive ? stats?.liveProfitUsd : stats?.paperProfitUsd)}
          valueClass={cn(((isLive ? stats?.liveProfitUsd : stats?.paperProfitUsd) ?? 0) >= 0 ? 'text-green-400' : 'text-destructive')}
          sublabel={stats && stats.totalTrades > 0 ? `Win ${(stats.winRate * 100).toFixed(0)}% · ${stats.totalTrades} trades` : undefined}
        />
        <StatCard label="Total Trades" value={stats?.totalTrades ?? 0} />
        <StatCard label="Opportunities" value={stats?.totalOpportunities ?? 0} />
        <StatCard label="Paths / Sec" value={(stats?.pathsPerSecond ?? 0).toFixed(0)} />
        <StatCard label="Opp / Min" value={(stats?.opportunitiesPerMinute ?? 0).toFixed(2)} />
        {isLive && (
          <StatCard
            label="Daily Loss"
            value={formatUsd(stats?.dailyLossUsd)}
            valueClass={cn((stats?.dailyLossUsd ?? 0) > 0 ? 'text-destructive' : 'text-muted-foreground')}
            sublabel={`Limit: ${formatUsd(config?.dailyLossLimitUsd)}`}
          />
        )}
      </div>

      {/* ── Performance Charts ───────────────────────────────────────────────── */}
      <PerformanceCharts history={history} />

      {/* ── Main Grid ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1 min-h-0">

        {/* Live Scanner Feed */}
        <Card className="lg:col-span-2 flex flex-col min-h-[400px]">
          <CardHeader className="py-3 flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <CardTitle>Live Scanner Feed</CardTitle>
            </div>
            <Badge variant="outline" className="text-[10px] bg-background">Last 50</Badge>
          </CardHeader>
          <CardContent className="flex-1 p-0 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10 border-b border-border shadow-sm">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[90px]">Time</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right" title="Top-of-book estimate — assumes you get the quoted price on all 3 legs">Net (quoted)</TableHead>
                  <TableHead className="text-right" title="The honest number: net edge after walking real order-book depth and paying fees on all 3 legs. This is what the bot actually decides on.">Real (depth)</TableHead>
                  <TableHead className="text-right" title="Age of the stalest of the 3 legs' quotes. A large value means the edge is likely an artifact of comparing a fresh price against an out-of-date one, not a real dislocation.">Age</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {opportunities.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No opportunities detected yet.</TableCell>
                  </TableRow>
                ) : opportunities.map((opp) => {
                  // Present only on live-mode candidates that reached the depth gate.
                  const extra = opp as unknown as { depthNetPct?: number | null; maxLegAgeMs?: number };
                  const depthNetPct = extra.depthNetPct;
                  const hasDepth = typeof depthNetPct === 'number';
                  const ageMs = extra.maxLegAgeMs;
                  const hasAge = typeof ageMs === 'number';
                  return (
                  <TableRow key={opp.id} className="group text-xs border-border/40">
                    <TableCell className="text-muted-foreground whitespace-nowrap">{formatRelativeTime(opp.timestamp)}</TableCell>
                    <TableCell className="font-medium tracking-tight whitespace-nowrap">
                      {opp.path.join(' → ')}
                      {opp.wasPaperTraded && <Badge variant="success" className="ml-2 text-[9px] px-1.5 py-0 h-4 leading-none">Traded</Badge>}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <ValueFlash value={formatPercent(opp.grossProfitPct)} type="number" />
                    </TableCell>
                    <TableCell className={cn('text-right whitespace-nowrap', opp.netProfitPct > 0 ? 'text-muted-foreground' : 'text-muted-foreground')}>
                      <ValueFlash value={formatPercent(opp.netProfitPct)} type="number" />
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-bold whitespace-nowrap',
                        !hasDepth ? 'text-muted-foreground/50'
                          : depthNetPct! > 0 ? 'text-green-400' : 'text-red-400',
                      )}
                      title={hasDepth ? undefined : 'Not depth-checked (paper mode, or skipped before the depth gate)'}
                    >
                      {hasDepth ? formatPercent(depthNetPct!) : '—'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right whitespace-nowrap tabular-nums',
                        !hasAge ? 'text-muted-foreground/50'
                          : ageMs! > 1000 ? 'text-red-400' : 'text-muted-foreground',
                      )}
                      title={hasAge && ageMs! > 1000 ? 'Stale — this edge is likely a timing artifact' : undefined}
                    >
                      {hasAge ? (ageMs! < 1000 ? `${ageMs}ms` : `${(ageMs! / 1000).toFixed(1)}s`) : '—'}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Right Column */}
        <div className="lg:col-span-2 flex flex-col gap-6">

          {/* Trade Log */}
          <Card className="flex-1 flex flex-col min-h-[260px]">
            <CardHeader className="py-3 flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart2 className="h-4 w-4 text-primary" />
                <CardTitle>Trade Log</CardTitle>
              </div>
              <Badge variant="outline" className="text-[10px] bg-background">Last 50</Badge>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10 border-b border-border shadow-sm">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Path</TableHead>
                    <TableHead className="text-center w-14">Mode</TableHead>
                    <TableHead className="text-right">Net %</TableHead>
                    <TableHead className="text-right">Net P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trades.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No trades executed yet.</TableCell>
                    </TableRow>
                  ) : trades.map((trade) => {
                    const expanded = expandedTrades.has(trade.id);
                    const profit = trade.netProfitUsd >= 0;
                    return (
                      <React.Fragment key={trade.id}>
                        <TableRow
                          className="text-xs border-border/40 cursor-pointer hover:bg-muted/30"
                          onClick={() => toggleTradeExpanded(trade.id)}
                        >
                          <TableCell className="font-medium tracking-tight whitespace-nowrap">
                            <span className="inline-flex items-center gap-1">
                              {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                              {trade.path.join(' → ')}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">
                            {trade.mode === 'live'
                              ? <Badge className="text-[8px] px-1 py-0 h-3.5 bg-amber-500/20 text-amber-400 border-amber-500/30">LIVE</Badge>
                              : <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 text-muted-foreground">PAPER</Badge>
                            }
                          </TableCell>
                          <TableCell className={cn('text-right', profit ? 'text-green-400' : 'text-destructive')}>{formatPercent(trade.netProfitPct)}</TableCell>
                          <TableCell className={cn('text-right font-bold px-2', profit ? 'text-green-400 bg-green-500/5' : 'text-destructive bg-destructive/5')}>
                            {profit ? '+' : '-'}{formatUsd(Math.abs(trade.netProfitUsd))}
                          </TableCell>
                        </TableRow>
                        {expanded && (
                          <TableRow className="border-border/40 bg-background/40">
                            <TableCell colSpan={4} className="py-2">
                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
                                <span>Notional: <span className="text-foreground font-mono">{formatUsd(trade.notionalSize)}</span></span>
                                <span>Gross: <span className="text-foreground font-mono">{formatUsd(trade.grossProfitUsd)}</span></span>
                                <span>When: <span className="text-foreground">{formatRelativeTime(trade.timestamp)}</span></span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                {(trade.symbols ?? []).map((sym, i) => (
                                  <div key={i} className="rounded border border-border/60 bg-card/50 px-2 py-1.5">
                                    <div className="flex items-center justify-between">
                                      <span className="text-[9px] text-muted-foreground uppercase">Leg {i + 1}</span>
                                      <span className="font-mono text-xs text-foreground">{sym}</span>
                                    </div>
                                    <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                                      <span>Price</span>
                                      <span className="font-mono text-foreground">
                                        {(trade.fillPrices?.[i] ?? trade.prices?.[i])?.toFixed?.(6) ?? '—'}
                                      </span>
                                    </div>
                                    {trade.orderIds?.[i] !== undefined && (
                                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                        <span>Order</span>
                                        <span className="font-mono text-foreground">#{trade.orderIds[i]}</span>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Config Card */}
          <Card className="shrink-0 bg-card border-border">
            <CardHeader className="py-3">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Configuration</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-5 pt-2">

              {/* Algorithm Settings */}
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Algorithm</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="notionalSize" className="text-xs">Notional ($)</Label>
                    <Input id="notionalSize" value={notionalSize} onChange={e => setNotionalSize(e.target.value)} type="number" step="10" className="bg-background/50 h-8 text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="feeRate" className="text-xs">Fee Rate (%)</Label>
                    <Input id="feeRate" value={feeRate} onChange={e => setFeeRate(e.target.value)} type="number" step="0.01" className="bg-background/50 h-8 text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="minProfit" className="text-xs">Min Profit (%)</Label>
                    <Input id="minProfit" value={minProfitThreshold} onChange={e => setMinProfitThreshold(e.target.value)} type="number" step="0.01" className="bg-background/50 h-8 text-xs" />
                  </div>
                </div>
              </div>

              {/* Safety Controls */}
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                  <ShieldAlert className="h-3 w-3" /> Safety Controls
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
                    <Label htmlFor="maxSlippage" className="text-xs">Max Slippage (%)</Label>
                    <Input id="maxSlippage" value={maxSlippage} onChange={e => setMaxSlippage(e.target.value)} type="number" step="0.1" className="bg-background/50 h-8 text-xs" title="Abort a live triangle if a leg fills worse than expected by more than this. 0 disables." />
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
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Top 5 Panels ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TopOpportunitiesCard
          title="Top 5 This Scan"
          subtitle="Best triangles in the last 2s window"
          icon={<TrendingUp className="h-4 w-4 text-primary" />}
          items={stats?.topScan ?? []}
          emptyMessage="Waiting for first scan window..."
        />
        <TopOpportunitiesCard
          title="Top 5 Today"
          subtitle="Best triangles since server start"
          icon={<Trophy className="h-4 w-4 text-amber-400" />}
          items={stats?.topToday ?? []}
          emptyMessage="No data yet — scanning in progress..."
          highlight
        />
      </div>

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
