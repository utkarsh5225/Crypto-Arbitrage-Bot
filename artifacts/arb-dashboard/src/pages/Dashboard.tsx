import React, { useState, useEffect } from 'react';
import { 
  useGetStats, 
  useGetConfig, 
  useUpdateConfig, 
  useGetOpportunities, 
  useGetTrades,
  getGetOpportunitiesQueryKey,
  getGetTradesQueryKey,
  getGetStatsQueryKey,
  getGetConfigQueryKey
} from '@workspace/api-client-react';
import { useBotStream } from '@/hooks/use-bot-stream';
import { formatPercent, formatUsd, formatUptime, cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ValueFlash } from '@/components/ValueFlash';
import { formatDistanceToNow } from 'date-fns';
import { Activity, Zap, Server, Settings2, BarChart2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

export default function Dashboard() {
  // Setup SSE
  const { scannerConnected } = useBotStream();

  // Queries
  const { data: stats } = useGetStats({ query: { queryKey: getGetStatsQueryKey() } });
  const { data: config } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const { data: opportunitiesResponse } = useGetOpportunities({ limit: 50 }, { query: { queryKey: getGetOpportunitiesQueryKey({ limit: 50 }) } });
  const { data: tradesResponse } = useGetTrades({ limit: 50 }, { query: { queryKey: getGetTradesQueryKey({ limit: 50 }) } });
  const updateConfig = useUpdateConfig();

  // Config local state
  const [feeRate, setFeeRate] = useState<string>('');
  const [minProfitThreshold, setMinProfitThreshold] = useState<string>('');
  const [notionalSize, setNotionalSize] = useState<string>('');

  useEffect(() => {
    if (config) {
      setFeeRate((config.feeRate * 100).toString());
      setMinProfitThreshold((config.minProfitThreshold * 100).toString());
      setNotionalSize(config.notionalSize.toString());
    }
  }, [config]);

  const handleSaveConfig = () => {
    updateConfig.mutate({
      data: {
        feeRate: parseFloat(feeRate) / 100,
        minProfitThreshold: parseFloat(minProfitThreshold) / 100,
        notionalSize: parseFloat(notionalSize),
      }
    }, {
      onSuccess: () => {
        toast.success('Configuration updated successfully');
      },
      onError: (err) => {
        toast.error('Failed to update config: ' + err.message);
      }
    });
  };

  const opportunities = opportunitiesResponse?.data || [];
  const trades = tradesResponse?.data || [];

  return (
    <div className="min-h-screen bg-background text-foreground p-4 lg:p-6 overflow-hidden flex flex-col gap-6 font-mono selection:bg-primary/30">
      
      {/* Header & Status */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary flex items-center gap-2">
            <Zap className="h-6 w-6 fill-primary/20" />
            TRI-ARB TERMINAL <span className="text-muted-foreground text-sm font-normal">v0.1.0</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-4 border border-border bg-card px-4 py-2 rounded-md shadow-sm">
          <div className="flex items-center gap-2 pr-4 border-r border-border">
            <div className={cn("h-2.5 w-2.5 rounded-full animate-pulse", scannerConnected ? "bg-green-500" : "bg-destructive")} />
            <span className="text-sm uppercase tracking-widest text-muted-foreground">Scanner</span>
            <Badge variant={scannerConnected ? "success" : "destructive"} className="ml-1">
              {scannerConnected ? "Live" : "Offline"}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <div className="flex flex-col">
              <span className="text-[10px] text-muted-foreground uppercase leading-none">Uptime</span>
              <ValueFlash value={formatUptime(stats?.uptimeSeconds)} className="font-medium" />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] text-muted-foreground uppercase leading-none">Pairs</span>
              <ValueFlash value={stats?.pairsTracked || 0} className="font-medium" />
            </div>
          </div>
        </div>
      </header>

      {/* Stats Strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard 
          label="Total P&L" 
          value={formatUsd(stats?.totalProfitUsd)} 
          valueClass={cn((stats?.totalProfitUsd || 0) >= 0 ? "text-green-400" : "text-destructive")}
        />
        <StatCard label="Total Trades" value={stats?.totalTrades || 0} />
        <StatCard label="Total Opportunities" value={stats?.totalOpportunities || 0} />
        <StatCard label="Paths / Sec" value={(stats?.pathsPerSecond || 0).toFixed(0)} />
        <StatCard label="Opp / Min" value={(stats?.opportunitiesPerMinute || 0).toFixed(2)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1 min-h-0">
        
        {/* Left Column: Live Feed */}
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
                  <TableHead className="w-[100px]">Time</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {opportunities.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No opportunities detected yet.</TableCell>
                  </TableRow>
                ) : (
                  opportunities.map((opp) => (
                    <TableRow key={opp.id} className="group text-xs border-border/40">
                      <TableCell className="text-muted-foreground whitespace-nowrap">
                        {formatRelativeTime(opp.timestamp)}
                      </TableCell>
                      <TableCell className="font-medium tracking-tight whitespace-nowrap">
                        {opp.path.join(" → ")}
                        {opp.wasPaperTraded && <Badge variant="success" className="ml-2 text-[9px] px-1.5 py-0 h-4 leading-none">Traded</Badge>}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <ValueFlash value={formatPercent(opp.grossProfitPct)} type="number" />
                      </TableCell>
                      <TableCell className={cn("text-right font-medium whitespace-nowrap", opp.netProfitPct > 0 ? "text-green-400" : "text-muted-foreground")}>
                        <ValueFlash value={formatPercent(opp.netProfitPct)} type="number" />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Right Column: Trades & Config */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          
          {/* Trades Log */}
          <Card className="flex-1 flex flex-col min-h-[300px]">
            <CardHeader className="py-3 flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart2 className="h-4 w-4 text-primary" />
                <CardTitle>Paper Trade Log</CardTitle>
              </div>
              <Badge variant="outline" className="text-[10px] bg-background">Last 50</Badge>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10 border-b border-border shadow-sm">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Path</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">Net %</TableHead>
                    <TableHead className="text-right">Net P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trades.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No trades executed yet.</TableCell>
                    </TableRow>
                  ) : (
                    trades.map((trade) => (
                      <TableRow key={trade.id} className="text-xs border-border/40">
                        <TableCell className="font-medium tracking-tight whitespace-nowrap">
                          {trade.path.join(" → ")}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {formatUsd(trade.notionalSize)}
                        </TableCell>
                        <TableCell className="text-right text-green-400">
                          {formatPercent(trade.netProfitPct)}
                        </TableCell>
                        <TableCell className="text-right text-green-400 font-bold bg-green-500/5 px-2">
                          +{formatUsd(trade.netProfitUsd)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Config Panel */}
          <Card className="shrink-0 bg-card border-border">
            <CardHeader className="py-3">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Algorithm Config</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="notionalSize">Notional Size ($)</Label>
                  <Input 
                    id="notionalSize" 
                    value={notionalSize} 
                    onChange={e => setNotionalSize(e.target.value)} 
                    placeholder="1000"
                    type="number"
                    step="10"
                    className="bg-background/50"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="feeRate">Fee Rate (%)</Label>
                  <Input 
                    id="feeRate" 
                    value={feeRate} 
                    onChange={e => setFeeRate(e.target.value)} 
                    placeholder="0.1"
                    type="number"
                    step="0.01"
                    className="bg-background/50"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="minProfit">Min Profit (%)</Label>
                  <Input 
                    id="minProfit" 
                    value={minProfitThreshold} 
                    onChange={e => setMinProfitThreshold(e.target.value)} 
                    placeholder="0.1"
                    type="number"
                    step="0.01"
                    className="bg-background/50"
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-between items-center">
                <p className="text-[10px] text-muted-foreground max-w-[60%] leading-relaxed uppercase">
                  Configuration changes apply instantly to the scanner logic. Existing paths in evaluation will complete with old config.
                </p>
                <Button 
                  onClick={handleSaveConfig} 
                  disabled={updateConfig.isPending}
                  size="sm"
                  className="bg-primary text-background hover:bg-primary/80 font-bold"
                >
                  {updateConfig.isPending ? 'DEPLOYING...' : 'APPLY CONFIG'}
                </Button>
              </div>
            </CardContent>
          </Card>

        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, valueClass }: { label: string, value: string | number, valueClass?: string }) {
  return (
    <Card className="bg-card overflow-hidden">
      <div className="p-4 flex flex-col justify-center h-full">
        <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</span>
        <div className={cn("text-xl md:text-2xl font-bold tracking-tight", valueClass)}>
          <ValueFlash value={value} type={typeof value === 'string' ? 'text' : 'number'} />
        </div>
      </div>
    </Card>
  );
}

function formatRelativeTime(isoString: string) {
  try {
    const date = new Date(isoString);
    return formatDistanceToNow(date, { addSuffix: true, includeSeconds: true })
      .replace('about ', '')
      .replace('less than a minute ago', 'just now');
  } catch (e) {
    return isoString;
  }
}
