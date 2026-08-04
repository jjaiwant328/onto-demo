// Scenario & Impact Explorer — business-facing "what-if" + blast-radius views over
// the QSR supply-chain spine. Tab 1: pick an injected scenario (heat wave, supplier
// outage…) → projected impact (data) + the recommended play (guidance). Tab 2: pick a
// supplier / DC / ingredient → the downstream restaurants & items at risk.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Badge,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { Zap, Database, Sparkles, Loader2, ArrowRight, AlertTriangle } from 'lucide-react';
import { useProduct } from '../lib/product';
import {
  fetchScenarios,
  fetchScenarioImpact,
  fetchImpactEntities,
  fetchImpactTrace,
  type Scenario,
  type ScenarioImpact as ScenarioImpactT,
  type ImpactEntity,
  type ImpactTrace,
} from '../lib/scenarioImpact';

function titleCase(s: string): string {
  return (s || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

export function ScenarioImpact() {
  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Scenario &amp; Impact</h2>
        <p className="text-muted-foreground">
          See how a disruption ripples through the network, and the recommended play — grounded in the live data.
        </p>
      </div>
      <Tabs defaultValue="scenarios">
        <TabsList>
          <TabsTrigger value="scenarios">What-if scenarios</TabsTrigger>
          <TabsTrigger value="impact">Impact explorer</TabsTrigger>
        </TabsList>
        <TabsContent value="scenarios" className="mt-4">
          <ScenariosTab />
        </TabsContent>
        <TabsContent value="impact" className="mt-4">
          <ImpactTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ScenariosTab() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [impact, setImpact] = useState<ScenarioImpactT | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);

  useEffect(() => {
    void fetchScenarios().then((s) => {
      setScenarios(s);
      setLoading(false);
    });
  }, []);

  const pick = (id: string) => {
    setSelected(id);
    setImpact(null);
    setImpactLoading(true);
    void fetchScenarioImpact(id).then((r) => {
      setImpact(r);
      setImpactLoading(false);
    });
  };

  if (loading) return <Skeleton className="h-40 w-full" />;
  if (scenarios.length === 0)
    return <Card className="shadow-sm"><CardContent className="py-6 text-sm text-muted-foreground">No scenarios in the catalog.</CardContent></Card>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
      {/* scenario list */}
      <div className="space-y-2">
        {scenarios.map((s) => (
          <Card
            key={s.scenario_id}
            className={`shadow-sm cursor-pointer transition-shadow hover:shadow-md ${selected === s.scenario_id ? 'border-primary' : ''}`}
            onClick={() => pick(s.scenario_id)}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" /> {titleCase(s.scenario_type)}
              </CardTitle>
              <CardDescription className="text-xs">
                {s.scope_kind === 'national' || !s.scope_value ? 'Network-wide' : `${titleCase(s.scope_kind ?? '')}: ${s.scope_value}`}
                {s.start_date ? ` · ${s.start_date}${s.end_date ? ` → ${s.end_date}` : ''}` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">{s.description}</CardContent>
          </Card>
        ))}
      </div>

      {/* impact detail */}
      <div>
        {!selected ? (
          <Card className="shadow-sm h-full"><CardContent className="py-10 text-center text-sm text-muted-foreground">Select a scenario to see its projected impact and the recommended play.</CardContent></Card>
        ) : impactLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : impact ? (
          <ScenarioImpactDetail impact={impact} />
        ) : null}
      </div>
    </div>
  );
}

function ScenarioImpactDetail({ impact }: { impact: ScenarioImpactT }) {
  const imp = impact.impact ?? {};
  const count = Number(imp.impact_count ?? 0);
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">{titleCase(impact.scenario.scenario_type)} — projected impact</CardTitle>
        <CardDescription>{impact.scenario.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* data-derived impact */}
        <div>
          <Badge variant="secondary" className="gap-1 text-[10px] mb-1"><Database className="h-3 w-3" /> Data-derived</Badge>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-destructive">{count.toLocaleString()}</span>
            <span className="text-muted-foreground">{impact.impact_label}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            {Object.entries(imp)
              .filter(([k]) => k !== 'impact_count')
              .map(([k, v]) => (
                <span key={k}><span className="font-medium">{titleCase(k)}:</span> {String(v)}</span>
              ))}
          </div>
        </div>

        {/* recommended play (guidance) */}
        {impact.playbook.length > 0 && (
          <div className="space-y-1.5">
            <Badge variant="outline" className="gap-1 text-[10px]"><Sparkles className="h-3 w-3" /> Recommended play (guidance)</Badge>
            {impact.playbook.map((p, i) => (
              <div key={i} className="rounded-md border p-2">
                <div className="text-xs"><span className="font-medium">Likely cause:</span> {p.root_cause}</div>
                <div className="text-xs mt-0.5"><span className="font-medium">Do:</span> {p.recommended_action}</div>
                <Badge variant="secondary" className="text-[10px] mt-1">{p.source === 'db' ? 'data-derivable' : 'best-practice'}</Badge>
              </div>
            ))}
          </div>
        )}

        {/* reasoning rule */}
        {impact.rule && (
          <div className="rounded-md bg-muted/40 p-2 text-xs">
            <span className="font-medium">Why:</span> {impact.rule.if_conditions.join(' + ')} → {impact.rule.then_conclusion}
          </div>
        )}

        {impact.product && <ProductLink productName={impact.product.product_name} label={impact.product.display_name} />}
      </CardContent>
    </Card>
  );
}

function ProductLink({ productName, label }: { productName: string; label: string }) {
  const navigate = useNavigate();
  const { setSelectedProduct, showActionCenter, setShowActionCenter } = useProduct();
  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5"
      onClick={() => {
        setSelectedProduct(productName);
        if (!showActionCenter) setShowActionCenter(true);
        navigate('/action-center');
      }}
    >
      Work the "{label}" queue <ArrowRight className="h-3.5 w-3.5" />
    </Button>
  );
}

function ImpactTab() {
  const [type, setType] = useState<'supplier' | 'dc' | 'ingredient'>('supplier');
  const [entities, setEntities] = useState<ImpactEntity[]>([]);
  const [entityId, setEntityId] = useState<string>('');
  const [trace, setTrace] = useState<ImpactTrace | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setEntities([]);
    setEntityId('');
    setTrace(null);
    void fetchImpactEntities(type).then(setEntities);
  }, [type]);

  const run = (id: string) => {
    setEntityId(id);
    setTrace(null);
    setLoading(true);
    void fetchImpactTrace(type, id).then((t) => {
      setTrace(t);
      setLoading(false);
    });
  };

  const typeLabel = type === 'dc' ? 'distribution center' : type;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base">Blast radius</CardTitle>
        <CardDescription>
          Pick a {typeLabel} to see the downstream restaurants and items currently at risk if it's disrupted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={type} onValueChange={(v) => setType(v as 'supplier' | 'dc' | 'ingredient')}>
            <SelectTrigger className="w-44 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="supplier">Supplier</SelectItem>
              <SelectItem value="dc">Distribution center</SelectItem>
              <SelectItem value="ingredient">Ingredient</SelectItem>
            </SelectContent>
          </Select>
          <Select value={entityId} onValueChange={run}>
            <SelectTrigger className="w-72 text-xs"><SelectValue placeholder={`Choose a ${typeLabel}…`} /></SelectTrigger>
            <SelectContent>
              {entities.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.name} ({e.id})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        {trace && !loading && (
          <>
            <div className="flex flex-wrap gap-6 text-sm">
              <div>
                <div className="text-2xl font-bold text-destructive">{trace.total_restaurants.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">restaurants affected</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-foreground">{trace.total_positions.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">at-risk positions</div>
              </div>
            </div>
            {trace.rows.length === 0 ? (
              <div className="text-sm text-muted-foreground">No downstream stockout risk currently traced to this {typeLabel}.</div>
            ) : (
              <div className="max-h-[420px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{type === 'supplier' ? 'Ingredient' : 'Region'}</TableHead>
                      <TableHead className="text-right">Restaurants</TableHead>
                      <TableHead className="text-right">At-risk positions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trace.rows.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs font-medium flex items-center gap-1.5">
                          {(r.restaurants ?? 0) > 20 && <AlertTriangle className="h-3 w-3 text-destructive" />}
                          {r.name}
                        </TableCell>
                        <TableCell className="text-right text-xs">{Number(r.restaurants).toLocaleString()}</TableCell>
                        <TableCell className="text-right text-xs">{Number(r.at_risk_positions).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
