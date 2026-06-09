import { Brain, Zap, Mic, Globe, MessageSquare, Settings } from 'lucide-react';

const capabilities = [
  {
    icon: Mic,
    title: 'Voice Conversations',
    description: 'Real-time speech-to-text and text-to-speech with sub-second latency.',
    color: 'bg-indigo-50 text-indigo-600',
  },
  {
    icon: Globe,
    title: 'Multi-language Support',
    description: 'Handles calls in English, Hindi, and regional Indian languages.',
    color: 'bg-emerald-50 text-emerald-600',
  },
  {
    icon: MessageSquare,
    title: 'Lead Qualification',
    description: 'Automatically qualifies leads by budget, BHK, location, and timeline.',
    color: 'bg-amber-50 text-amber-600',
  },
  {
    icon: Settings,
    title: 'Configurable Personas',
    description: 'Customize agent name, tone, and property knowledge base.',
    color: 'bg-violet-50 text-violet-600',
  },
];

const upcomingFeatures = [
  'Multiple agent instances',
  'Custom scripts & call flows',
  'Agent performance comparison',
  'A/B testing for prompts',
  'Scheduled outbound campaigns',
  'Escalation rules & handoff logic',
];

export default function AgentsPage() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">AI Agents</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure and monitor your voice AI agents.
        </p>
      </div>

      {/* Active Agent card */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-indigo-600 flex items-center justify-center flex-shrink-0">
              <Brain className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-gray-900">Propacity Voice Agent</h2>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
                  Active
                </span>
              </div>
              <p className="text-sm text-gray-500 mt-0.5">
                Powered by Claude + ElevenLabs Nova · Real-time telephony via Exotel
              </p>
            </div>
          </div>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
            Config Coming Soon
          </span>
        </div>

        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Calls Handled', value: '—' },
            { label: 'Avg CSAT', value: '—' },
            { label: 'Resolution Rate', value: '—' },
            { label: 'Uptime', value: '—' },
          ].map((stat) => (
            <div key={stat.label} className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-lg font-semibold text-gray-900">{stat.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Capabilities */}
      <div>
        <h2 className="text-base font-semibold text-gray-900 mb-4">Capabilities</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {capabilities.map((cap) => {
            const Icon = cap.icon;
            return (
              <div
                key={cap.title}
                className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-start gap-4"
              >
                <div
                  className={[
                    'h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5',
                    cap.color,
                  ].join(' ')}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{cap.title}</p>
                  <p className="text-sm text-gray-500 mt-1">{cap.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Upcoming features */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            <h2 className="text-base font-semibold text-gray-900">Upcoming Features</h2>
          </div>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
            Coming Soon
          </span>
        </div>
        <div className="px-6 py-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {upcomingFeatures.map((feature) => (
            <div key={feature} className="flex items-center gap-2.5 text-sm text-gray-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 flex-shrink-0" />
              {feature}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
