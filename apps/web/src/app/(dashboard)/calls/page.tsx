'use client';

import {
  PhoneIncoming,
  PhoneOff,
  Clock,
  Filter,
  Download,
  ChevronDown,
  ChevronUp,
  Play,
  Pause,
  Volume2,
  MessageSquare,
  Globe,
  PhoneCall,
  CheckCircle2,
  XCircle,
  PhoneMissed,
  Search,
  X,
  Hash,
  User,
  Phone,
  Briefcase,
  Timer,
  LogOut,
  LogIn,
  Activity,
} from 'lucide-react';
import { useCallsList, useCallStats, useCallDetail, useCallEvents } from '@/features/calls/hooks/useCalls';
import { useState, useRef, useMemo } from 'react';
import type { CallLog, CallStatus, CallEvent } from '@/features/calls/api/callsApi';

// ─── Formatters ────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDeltaMs(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  return `+${(ms / 1000).toFixed(2)}s`;
}

// ─── Language badge ────────────────────────────────────────────────────────────

const LANG_LABELS: Record<string, string> = {
  en: 'English', hi: 'Hindi', mr: 'Marathi', gu: 'Gujarati',
  ta: 'Tamil', te: 'Telugu', kn: 'Kannada', bn: 'Bengali', pa: 'Punjabi',
};

function LanguageBadge({ lang }: { lang: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs font-medium">
      <Globe className="h-3 w-3" />
      {LANG_LABELS[lang] ?? lang}
    </span>
  );
}

// ─── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<CallStatus, { label: string; color: string; Icon: React.ElementType; pulse?: boolean }> = {
  DIALING:   { label: 'Calling',   color: 'bg-blue-50 text-blue-600 border-blue-100',    Icon: PhoneCall,     pulse: true },
  COMPLETED: { label: 'Completed', color: 'bg-green-50 text-green-700 border-green-100', Icon: CheckCircle2 },
  FAILED:    { label: 'Failed',    color: 'bg-red-50 text-red-600 border-red-100',        Icon: XCircle },
  NO_ANSWER: { label: 'No Answer', color: 'bg-gray-50 text-gray-500 border-gray-100',     Icon: PhoneMissed },
};

function StatusBadge({ status }: { status: CallStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.COMPLETED;
  const { Icon } = cfg;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${cfg.color}`}>
      <Icon className={`h-3 w-3 ${cfg.pulse ? 'animate-pulse' : ''}`} />
      {cfg.label}
    </span>
  );
}

// ─── Audio player ──────────────────────────────────────────────────────────────

function AudioPlayer({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dur, setDur] = useState(0);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    playing ? el.pause() : el.play();
    setPlaying(!playing);
  };

  return (
    <div className="flex items-center gap-3 bg-gray-50 rounded-lg px-4 py-2.5 border border-gray-100 max-w-sm">
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={() => { const el = audioRef.current; if (el?.duration) setProgress(el.currentTime / el.duration); }}
        onLoadedMetadata={() => { const el = audioRef.current; if (el) setDur(el.duration); }}
        onEnded={() => setPlaying(false)}
      />
      <button onClick={toggle} className="h-8 w-8 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0 hover:bg-indigo-700 transition-colors">
        {playing ? <Pause className="h-3.5 w-3.5 text-white" /> : <Play className="h-3.5 w-3.5 text-white ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-gray-400">{formatDuration(Math.round(audioRef.current?.currentTime ?? 0))}</span>
          <span className="text-[10px] text-gray-400">{formatDuration(Math.round(dur))}</span>
        </div>
      </div>
      <Volume2 className="h-4 w-4 text-gray-400 flex-shrink-0" />
    </div>
  );
}

// ─── Event type config ─────────────────────────────────────────────────────────

const EVENT_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  'call.started':             { color: 'text-green-700',  bg: 'bg-green-50 border-green-200',    label: 'Call Started' },
  'call.ended':               { color: 'text-red-700',    bg: 'bg-red-50 border-red-200',         label: 'Call Ended' },
  'call.disposed':            { color: 'text-red-600',    bg: 'bg-red-50 border-red-200',         label: 'Call Disposed' },
  'transcript.user':          { color: 'text-blue-700',   bg: 'bg-blue-50 border-blue-200',       label: 'User Transcript' },
  'transcript.assistant':     { color: 'text-violet-700', bg: 'bg-violet-50 border-violet-200',   label: 'Agent Transcript' },
  'transcript.partial':       { color: 'text-sky-600',    bg: 'bg-sky-50 border-sky-200',         label: 'Partial Transcript' },
  'state.transition':         { color: 'text-amber-700',  bg: 'bg-amber-50 border-amber-200',     label: 'State Change' },
  'interruption':             { color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200',   label: 'Interruption' },
  'bargein.pending.cleared':  { color: 'text-orange-600', bg: 'bg-orange-50 border-orange-100',   label: 'Barge-in Cleared' },
  'nova.connected':           { color: 'text-teal-700',   bg: 'bg-teal-50 border-teal-200',       label: 'Nova Connected' },
  'nova.completion.start':    { color: 'text-teal-600',   bg: 'bg-teal-50 border-teal-100',       label: 'Nova Thinking' },
  'nova.content.start.audio': { color: 'text-teal-600',   bg: 'bg-teal-50 border-teal-100',       label: 'Nova Speaking' },
  'greeting.play.start':      { color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200',   label: 'Greeting Start' },
  'greeting.play.end':        { color: 'text-indigo-600', bg: 'bg-indigo-50 border-indigo-100',   label: 'Greeting End' },
  'mic.open':                 { color: 'text-cyan-700',   bg: 'bg-cyan-50 border-cyan-200',       label: 'Mic Opened' },
  'vad.speech.end':           { color: 'text-gray-600',   bg: 'bg-gray-50 border-gray-200',       label: 'VAD Speech End' },
  'speech-gate.open':         { color: 'text-cyan-600',   bg: 'bg-cyan-50 border-cyan-100',       label: 'Speech Gate Open' },
  'caller.audio.first':       { color: 'text-blue-600',   bg: 'bg-blue-50 border-blue-100',       label: 'First Audio' },
};

function getEventCfg(event: string) {
  return EVENT_CONFIG[event] ?? { color: 'text-gray-600', bg: 'bg-gray-50 border-gray-200', label: event };
}

// ─── Transcript tab ────────────────────────────────────────────────────────────

function TranscriptTab({ callId }: { callId: string }) {
  const { data, isLoading } = useCallEvents(callId);

  const turns = useMemo(() => {
    return (data?.events ?? [])
      .filter((e) => e.event === 'transcript.user' || e.event === 'transcript.assistant')
      .map((e) => ({
        isAgent: e.event === 'transcript.assistant',
        text: (e.data?.text as string) ?? '',
        ts: e.ts,
      }))
      .filter((t) => t.text.trim().length > 0);
  }, [data]);

  if (isLoading) {
    return <p className="text-sm text-gray-400 py-4 text-center">Loading transcript…</p>;
  }

  if (turns.length === 0) {
    return (
      <div className="flex flex-col items-center py-12 text-center">
        <MessageSquare className="h-10 w-10 text-gray-200 mb-3" />
        <p className="text-sm font-medium text-gray-500">Transcript not available</p>
        <p className="text-xs text-gray-400 mt-1">No speech events found in the call log.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-h-96 overflow-y-auto pr-1 py-1">
      {turns.map((turn, i) => (
        <div key={i} className={`flex gap-2.5 ${turn.isAgent ? 'flex-row-reverse' : ''}`}>
          <div className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-bold ${turn.isAgent ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
            {turn.isAgent ? 'AI' : 'C'}
          </div>
          <div className={`max-w-[75%] flex flex-col gap-0.5 ${turn.isAgent ? 'items-end' : 'items-start'}`}>
            <div className={`text-[10px] font-medium px-1 ${turn.isAgent ? 'text-right text-indigo-500' : 'text-gray-400'}`}>
              {turn.isAgent ? 'Agent' : 'Caller'} · {new Date(turn.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
            <div className={`text-sm leading-relaxed rounded-2xl px-3.5 py-2.5 ${turn.isAgent ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-white border border-gray-100 text-gray-800 rounded-tl-sm shadow-sm'}`}>
              {turn.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Logs tab ──────────────────────────────────────────────────────────────────

const KEY_EVENTS = new Set([
  'call.started', 'call.ended', 'transcript.user',
  'transcript.assistant', 'state.transition', 'interruption',
]);

function LogsTab({ callId }: { callId: string }) {
  const { data, isLoading } = useCallEvents(callId);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'key'>('all');

  const events: CallEvent[] = data?.events ?? [];

  const filtered = useMemo(() => {
    let list = events;
    if (filter === 'key') list = list.filter((e) => KEY_EVENTS.has(e.event));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((e) =>
        e.event.toLowerCase().includes(q) ||
        JSON.stringify(e.data ?? {}).toLowerCase().includes(q) ||
        e.state.toLowerCase().includes(q),
      );
    }
    return list;
  }, [events, search, filter]);

  if (isLoading) {
    return <p className="text-sm text-gray-400 py-4 text-center">Loading logs…</p>;
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center py-12 text-center">
        <Activity className="h-10 w-10 text-gray-200 mb-3" />
        <p className="text-sm font-medium text-gray-500">No event logs available</p>
        <p className="text-xs text-gray-400 mt-1">Logs are generated during live calls.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Search events…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-8 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
              <X className="h-3.5 w-3.5 text-gray-400 hover:text-gray-600" />
            </button>
          )}
        </div>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(['all', 'key'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${filter === f ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {f === 'all' ? `All (${events.length})` : 'Key only'}
            </button>
          ))}
        </div>
      </div>

      {/* Event list */}
      <div className="max-h-80 overflow-y-auto space-y-1.5 pr-0.5">
        {filtered.length === 0 && (
          <p className="text-xs text-gray-400 text-center py-6">No events match your filter.</p>
        )}
        {filtered.map((evt, i) => {
          const cfg = getEventCfg(evt.event);
          const dataKeys = Object.keys(evt.data ?? {});
          return (
            <div key={i} className={`rounded-lg border px-3 py-2 ${cfg.bg}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-[10px] font-bold font-mono flex-shrink-0 ${cfg.color}`}>
                    {formatDeltaMs(evt.delta)}
                  </span>
                  <span className={`text-xs font-semibold ${cfg.color}`}>{cfg.label}</span>
                  <span className="text-[10px] text-gray-400 font-mono truncate hidden sm:block">{evt.event}</span>
                </div>
                <span className="text-[10px] text-gray-400 flex-shrink-0 font-mono">{evt.state}</span>
              </div>
              {dataKeys.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  {dataKeys.slice(0, 4).map((k) => {
                    const v = evt.data![k];
                    const display = typeof v === 'string' ? v : JSON.stringify(v);
                    return (
                      <span key={k} className="text-[10px] text-gray-500">
                        <span className="font-medium text-gray-600">{k}:</span>{' '}
                        <span className="font-mono">{display.length > 80 ? display.slice(0, 80) + '…' : display}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Call detail panel ─────────────────────────────────────────────────────────

type DetailTab = 'transcript' | 'logs';

function MetaItem({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 min-w-0">
      <div className="flex-shrink-0 h-7 w-7 rounded-md bg-gray-100 flex items-center justify-center mt-0.5">
        <Icon className="h-3.5 w-3.5 text-gray-500" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">{label}</p>
        <div className="text-sm font-medium text-gray-800 truncate">{value ?? '—'}</div>
      </div>
    </div>
  );
}

function CallDetailPanel({ log }: { log: CallLog }) {
  const [tab, setTab] = useState<DetailTab>('transcript');
  const { data: detail } = useCallDetail(log.id);

  const contactName  = detail?.contact?.name  ?? detail?.Lead?.name  ?? log.Lead?.name  ?? '—';
  const contactPhone = detail?.contact?.phone ?? detail?.Lead?.phone ?? log.from        ?? '—';
  const campaignName = detail?.campaign?.name ?? '—';
  const startedAt    = detail?.startedAt      ?? log.createdAt;
  const endedAt      = detail?.endedAt;
  const isActive     = log.status === 'DIALING';

  return (
    <div className="px-6 pb-5 pt-3 bg-gray-50/40 border-t border-gray-100">

      {/* Metadata grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 mb-4 p-4 bg-white rounded-xl border border-gray-100 shadow-sm">
        <MetaItem icon={Hash}      label="Call ID"    value={<span className="font-mono text-xs">{log.callSid.slice(0, 20)}…</span>} />
        <MetaItem icon={User}      label="Contact"    value={contactName} />
        <MetaItem icon={Phone}     label="Phone"      value={contactPhone} />
        <MetaItem icon={Briefcase} label="Campaign"   value={campaignName} />
        <MetaItem icon={Activity}  label="Status"     value={<StatusBadge status={log.status ?? 'COMPLETED'} />} />
        <MetaItem icon={Timer}     label="Duration"   value={isActive ? <span className="text-blue-600 animate-pulse text-xs">In progress…</span> : formatDuration(log.duration)} />
        <MetaItem icon={LogIn}     label="Start Time" value={formatTime(startedAt)} />
        <MetaItem icon={LogOut}    label="End Time"   value={endedAt ? formatTime(endedAt) : (isActive ? <span className="text-blue-500 text-xs">Active</span> : '—')} />
      </div>

      {/* Summary */}
      {log.summary && (
        <div className="mb-4 px-4 py-3 bg-indigo-50/60 border border-indigo-100 rounded-xl">
          <p className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wide mb-1">AI Summary</p>
          <p className="text-sm text-indigo-900 leading-relaxed">{log.summary}</p>
        </div>
      )}

      {/* Recording */}
      {log.recordingUrl && (
        <div className="mb-4">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Recording</p>
          <AudioPlayer url={log.recordingUrl} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-3 border-b border-gray-200">
        {([
          { id: 'transcript' as const, label: 'Transcript', Icon: MessageSquare },
          { id: 'logs'       as const, label: 'Call Logs',  Icon: Activity },
        ]).map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'transcript' && <TranscriptTab callId={log.id} />}
      {tab === 'logs'       && <LogsTab       callId={log.id} />}
    </div>
  );
}

// ─── Call row ──────────────────────────────────────────────────────────────────

function CallRow({ log, expanded, onToggle }: { log: CallLog; expanded: boolean; onToggle: () => void }) {
  const caller   = log.Lead?.name ?? log.from ?? '—';
  const isActive = log.status === 'DIALING';
  return (
    <div className={`border-b border-gray-50 last:border-0 ${isActive ? 'bg-blue-50/30' : ''}`}>
      <button
        onClick={onToggle}
        className="w-full text-left grid grid-cols-7 gap-3 px-6 py-3.5 hover:bg-gray-50/70 transition-colors items-center"
      >
        <div className="col-span-2 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{caller}</p>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{log.from ?? '—'}</p>
        </div>
        <div><StatusBadge status={log.status ?? 'COMPLETED'} /></div>
        <span className="text-sm text-gray-600">{formatDate(log.createdAt)}</span>
        <span className="text-sm text-gray-600">{isActive ? '—' : formatDuration(log.duration)}</span>
        <div>{!isActive && <LanguageBadge lang={log.language} />}</div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-gray-500 truncate flex-1">{log.summary ?? '—'}</p>
          {expanded
            ? <ChevronUp   className="h-4 w-4 text-gray-400 flex-shrink-0" />
            : <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" />
          }
        </div>
      </button>

      {expanded && <CallDetailPanel log={log} />}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function CallsPage() {
  const [page, setPage]         = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data: stats, isLoading: statsLoading } = useCallStats();
  const { data: list,  isLoading: listLoading  } = useCallsList(page);

  const statCards = [
    { label: 'Total Calls',  value: statsLoading ? '…' : String(stats?.total     ?? '—'), icon: PhoneIncoming, color: 'bg-indigo-50 text-indigo-600' },
    { label: 'Avg Duration', value: statsLoading ? '…' : (stats?.avgDuration     ?? '—'), icon: Clock,         color: 'bg-amber-50 text-amber-600'  },
    { label: 'Missed Calls', value: statsLoading ? '…' : String(stats?.missed    ?? '—'), icon: PhoneOff,      color: 'bg-red-50 text-red-500'      },
  ];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Call Logs</h1>
          <p className="mt-1 text-sm text-gray-500">View and manage all inbound and outbound AI calls.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
            <Filter className="h-4 w-4" /> Filter
          </button>
          <button className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
            <Download className="h-4 w-4" /> Export
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {statCards.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
              <div className={`h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 ${s.color}`}>
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500">{s.label}</p>
                <p className="text-xl font-semibold text-gray-900 mt-0.5">{s.value}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            Recent Calls
            {list && <span className="ml-2 text-sm font-normal text-gray-400">({list.total} total)</span>}
          </h2>
        </div>

        {/* Header row */}
        <div className="hidden sm:grid grid-cols-7 gap-3 px-6 py-3 bg-gray-50 border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
          <span className="col-span-2">Caller</span>
          <span>Status</span>
          <span>Date &amp; Time</span>
          <span>Duration</span>
          <span>Language</span>
          <span>Summary</span>
        </div>

        {listLoading && (
          <div className="divide-y divide-gray-50">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="grid grid-cols-7 gap-3 px-6 py-3.5 animate-pulse">
                <div className="col-span-2 space-y-1.5">
                  <div className="h-3 w-32 bg-gray-200 rounded" />
                  <div className="h-3 w-24 bg-gray-100 rounded" />
                </div>
                {Array.from({ length: 5 }).map((_, j) => (
                  <div key={j} className="h-3 w-20 bg-gray-100 rounded" />
                ))}
              </div>
            ))}
          </div>
        )}

        {!listLoading && list && list.logs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-6">
            <div className="h-14 w-14 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
              <PhoneIncoming className="h-7 w-7 text-indigo-400" />
            </div>
            <p className="text-sm font-semibold text-gray-900">No call logs yet</p>
            <p className="text-sm text-gray-500 mt-1 max-w-xs">
              Call history will appear once your AI agent starts receiving calls.
            </p>
          </div>
        )}

        {!listLoading && list && list.logs.length > 0 && (
          <>
            {list.logs.map((log) => (
              <CallRow
                key={log.id}
                log={log}
                expanded={expandedId === log.id}
                onToggle={() => setExpandedId((prev) => (prev === log.id ? null : log.id))}
              />
            ))}

            {list.pages > 1 && (
              <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
                <p className="text-sm text-gray-500">Page {list.page} of {list.pages}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="px-3 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(list.pages, p + 1))}
                    disabled={page === list.pages}
                    className="px-3 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
