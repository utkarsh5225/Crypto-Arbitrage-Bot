import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, Activity } from 'lucide-react';
import type { MetricSample } from '@/hooks/use-bot-stream';
import { formatUsd } from '@/lib/utils';

// Theme tokens (dark terminal). Single-series charts, so no categorical palette
// is needed — just high-contrast marks against the near-black surface.
const GREEN = 'hsl(142 71% 45%)'; // --primary
const RED = 'hsl(0 84% 60%)'; // --destructive
const MUTED = 'hsl(240 5% 65%)'; // --muted-foreground
const GRID = 'hsl(240 6% 15%)'; // --card-border

function timeLabel(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function PnlTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as MetricSample;
  const positive = p.pnl >= 0;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg">
      <div className="text-muted-foreground mb-0.5">{timeLabel(p.t)}</div>
      <div className={positive ? 'text-green-400 font-bold' : 'text-destructive font-bold'}>
        {positive ? '+' : '-'}
        {formatUsd(Math.abs(p.pnl)).replace('$', '$')}
      </div>
    </div>
  );
}

export function PerformanceCharts({ history }: { history: MetricSample[] }) {
  const hasData = history.length >= 2;
  const latest = history[history.length - 1];
  const pnl = latest?.pnl ?? 0;
  const pnlPositive = pnl >= 0;
  const stroke = pnlPositive ? GREEN : RED;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Cumulative P&L — spans 2/3 on desktop */}
      <Card className="lg:col-span-2 flex flex-col">
        <CardHeader className="py-3 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            <CardTitle>Total P&amp;L</CardTitle>
          </div>
          <Badge
            variant="outline"
            className={pnlPositive ? 'text-green-400 border-green-500/30' : 'text-destructive border-destructive/30'}
          >
            {pnlPositive ? '+' : '-'}
            {formatUsd(Math.abs(pnl)).replace('$', '$')}
          </Badge>
        </CardHeader>
        <CardContent className="flex-1 p-2 min-h-[180px]">
          {!hasData ? (
            <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground">
              Collecting data… the P&amp;L curve builds as the bot runs.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="t"
                  tickFormatter={timeLabel}
                  tick={{ fill: MUTED, fontSize: 10 }}
                  stroke={GRID}
                  minTickGap={48}
                />
                <YAxis
                  tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
                  tick={{ fill: MUTED, fontSize: 10 }}
                  stroke={GRID}
                  width={44}
                />
                <ReferenceLine y={0} stroke={MUTED} strokeDasharray="3 3" strokeOpacity={0.5} />
                <Tooltip content={<PnlTooltip />} cursor={{ stroke: MUTED, strokeOpacity: 0.4 }} />
                <Area
                  type="monotone"
                  dataKey="pnl"
                  stroke={stroke}
                  strokeWidth={2}
                  fill="url(#pnlFill)"
                  isAnimationActive={false}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Opportunities / min sparkline */}
      <Card className="flex flex-col">
        <CardHeader className="py-3 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <CardTitle>Opportunities / min</CardTitle>
          </div>
          <Badge variant="outline" className="text-[10px] bg-background">
            {latest ? latest.oppMin.toFixed(1) : '0'}
          </Badge>
        </CardHeader>
        <CardContent className="flex-1 p-2 min-h-[180px]">
          {!hasData ? (
            <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground">
              Collecting data…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <XAxis
                  dataKey="t"
                  tickFormatter={timeLabel}
                  tick={{ fill: MUTED, fontSize: 10 }}
                  stroke={GRID}
                  minTickGap={48}
                />
                <YAxis tick={{ fill: MUTED, fontSize: 10 }} stroke={GRID} width={28} allowDecimals={false} />
                <Tooltip
                  cursor={{ stroke: MUTED, strokeOpacity: 0.4 }}
                  contentStyle={{
                    background: 'hsl(240 10% 6%)',
                    border: '1px solid hsl(240 6% 15%)',
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                  labelFormatter={(v) => timeLabel(Number(v))}
                  formatter={(v: any) => [Number(v).toFixed(1), 'opp/min']}
                />
                <Line
                  type="monotone"
                  dataKey="oppMin"
                  stroke={GREEN}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
