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
} from 'lucide-react';
import { useCallsList, useCallStats, useCallDetail } from '@/features/calls/hooks/useCalls';
import { useState, useRef } from 'react';
import type { CallLog, CallStatus } from '@/features/calls/api/callsApi';

function formatDuration(seconds: number): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const LANG_LABELS: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  gu: 'Gujarati',
  ta: 'Tamil',
  te: 'Telugu',
  kn: 'Kannada',
  bn: 'Bengali',
  pa: 'Punjabi',
};

function LanguageBadge({ lang }: { lang: string }) {
  const label = LANG_LABELS[lang] ?? lang;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs font-medium">
      <Globe className="h-3 w-3" />
      {label}
    </span>
  );
}

const STATUS_CONFIG: Record<CallStatus, { label: string; color: string; Icon: React.ElementType; pulse?: boolean }> = {
  DIALING:   { label: 'Calling',   color: 'bg-blue-50 text-blue-600 border-blue-100',   Icon: PhoneCall,     pulse: true },
  COMPLETED: { label: 'Completed', color: 'bg-green-50 text-green-700 border-green-100', Icon: CheckCircle2 },
  FAILED:    { label: 'Failed',    color: 'bg-red-50 text-red-600 border-red-100',       Icon: XCircle },
  NO_ANSWER: { label: 'No Answer', color: 'bg-gray-50 text-gray-500 border-gray-100',    Icon: PhoneMissed },
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

function AudioPlayer({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play();
    }
    setPlaying(!playing);
  };

  return (
    <div className="flex items-center gap-3 bg-gray-50 rounded-lg px-4 py-2.5 border border-gray-100 max-w-sm">
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={() => {
          const el = audioRef.current;
          if (el && el.duration) setProgress(el.currentTime / el.duration);
        }}
        onLoadedMetadata={() => {
          const el = audioRef.current;
          if (el) setDuration(el.duration);
        }}
        onEnded={() => setPlaying(false)}
      />
      <button
        onClick={toggle}
        className="h-8 w-8 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0 hover:bg-indigo-700 transition-colors"
      >
        {playing ? (
          <Pause className="h-3.5 w-3.5 text-white" />
        ) : (
          <Play className="h-3.5 w-3.5 text-white ml-0.5" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-indigo-500 rounded-full transition-all"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-gray-400">
            {formatDuration(Math.round((audioRef.current?.currentTime ?? 0)))}
          </span>
          <span className="text-[10px] text-gray-400">{formatDuration(Math.round(duration))}</span>
        </div>
      </div>
      <Volume2 className="h-4 w-4 text-gray-400 flex-shrink-0" />
    </div>
  );
}

function TranscriptPanel({ callId }: { callId: string }) {
  const { data, isLoading } = useCallDetail(callId);
  const turns = data?.Conversation ?? [];

  if (isLoading) {
    return <p className="text-sm text-gray-400 py-2">Loading transcript…</p>;
  }

  if (turns.length === 0) {
    return (
      <p className="text-sm text-gray-400 py-2">No transcript available for this call.</p>
    );
  }

  return (
    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
      {turns
        .filter((t) => t.role !== 'SYSTEM')
        .map((turn) => (
          <div
            key={turn.id}
            className={`flex gap-3 ${turn.role === 'ASSISTANT' ? 'flex-row-reverse' : ''}`}
          >
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 h-fit mt-0.5 ${
                turn.role === 'ASSISTANT'
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'bg-gray-100 text-gray-600'
              }`}
            >
              {turn.role === 'ASSISTANT' ? 'AI' : 'Caller'}
            </span>
            <p
              className={`text-sm leading-relaxed rounded-xl px-3 py-2 max-w-prose ${
                turn.role === 'ASSISTANT'
                  ? 'bg-indigo-50 text-indigo-900'
                  : 'bg-white border border-gray-100 text-gray-800'
              }`}
            >
              {turn.content}
            </p>
          </div>
        ))}
    </div>
  );
}

function CallRow({ log, expanded, onToggle }: { log: CallLog; expanded: boolean; onToggle: () => void }) {
  const caller = log.Lead?.name ?? log.from ?? '—';
  const isActive = log.status === 'DIALING';
  return (
    <div className={`border-b border-gray-50 last:border-0 ${isActive ? 'bg-blue-50/30' : ''}`}>
      <button
        onClick={onToggle}
        className="w-full text-left grid grid-cols-7 gap-3 px-6 py-3.5 hover:bg-gray-50/70 transition-colors items-start"
      >
        <div className="col-span-2 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{caller}</p>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{log.from ?? '—'}</p>
        </div>
        <div>
          <StatusBadge status={log.status ?? 'COMPLETED'} />
        </div>
        <span className="text-sm text-gray-600">{formatDate(log.createdAt)}</span>
        <span className="text-sm text-gray-600">{isActive ? '—' : formatDuration(log.duration)}</span>
        <div>
          {!isActive && <LanguageBadge lang={log.language} />}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-gray-500 truncate flex-1">{log.summary ?? '—'}</p>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-gray-400 flex-shrink-0" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-6 pb-5 pt-1 bg-gray-50/40 border-t border-gray-100 space-y-4">
          {log.summary && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Summary</p>
              <p className="text-sm text-gray-700 leading-relaxed">{log.summary}</p>
            </div>
          )}

          {log.recordingUrl && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Recording</p>
              <AudioPlayer url={log.recordingUrl} />
            </div>
          )}

          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <MessageSquare className="h-3.5 w-3.5 text-gray-400" />
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Transcript</p>
            </div>
            <TranscriptPanel callId={log.id} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function CallsPage() {
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data: stats, isLoading: statsLoading } = useCallStats();
  const { data: list, isLoading: listLoading } = useCallsList(page);

  const statCards = [
    {
      label: 'Total Calls',
      value: statsLoading ? '…' : String(stats?.total ?? '—'),
      icon: PhoneIncoming,
      color: 'bg-indigo-50 text-indigo-600',
    },
    {
      label: 'Avg Duration',
      value: statsLoading ? '…' : (stats?.avgDuration ?? '—'),
      icon: Clock,
      color: 'bg-amber-50 text-amber-600',
    },
    {
      label: 'Missed Calls',
      value: statsLoading ? '…' : String(stats?.missed ?? '—'),
      icon: PhoneOff,
      color: 'bg-red-50 text-red-500',
    },
  ];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Call Logs</h1>
          <p className="mt-1 text-sm text-gray-500">
            View and manage all inbound and outbound AI calls.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
            <Filter className="h-4 w-4" />
            Filter
          </button>
          <button className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
            <Download className="h-4 w-4" />
            Export
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {statCards.map((s) => {
          const Icon = s.icon;
          return (
            <div
              key={s.label}
              className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4"
            >
              <div
                className={[
                  'h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0',
                  s.color,
                ].join(' ')}
              >
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
            {list && (
              <span className="ml-2 text-sm font-normal text-gray-400">({list.total} total)</span>
            )}
          </h2>
        </div>

        {/* Table header */}
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
              <div key={i} className="grid grid-cols-6 gap-4 px-6 py-3.5 animate-pulse">
                <div className="col-span-2 space-y-1.5">
                  <div className="h-3 w-32 bg-gray-200 rounded" />
                  <div className="h-3 w-24 bg-gray-100 rounded" />
                </div>
                {Array.from({ length: 4 }).map((_, j) => (
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
              Call history will appear here once your AI agent starts receiving calls.
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

            {/* Pagination */}
            {list.pages > 1 && (
              <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
                <p className="text-sm text-gray-500">
                  Page {list.page} of {list.pages}
                </p>
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
