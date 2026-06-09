export function AuthBanner() {
  return (
    <div className="hidden lg:flex lg:w-[45%] xl:w-1/2 flex-col bg-gray-950 relative overflow-hidden">
      {/* Gradient mesh background */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-950 via-gray-950 to-gray-900" />
        <div className="absolute top-0 left-0 w-[600px] h-[600px] rounded-full bg-indigo-600/10 blur-3xl -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-violet-600/10 blur-3xl translate-x-1/3 translate-y-1/3" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />
      </div>

      {/* Content */}
      <div className="relative z-10 flex flex-col h-full px-12 py-12">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-900/50">
            <span className="text-white font-bold text-base">P</span>
          </div>
          <span className="text-white font-semibold text-lg tracking-tight">Propacity</span>
        </div>

        {/* Main copy */}
        <div className="flex-1 flex flex-col justify-center">
          <div className="space-y-6 max-w-sm">
            <div className="inline-flex items-center gap-2 rounded-full bg-indigo-500/10 border border-indigo-500/20 px-3 py-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
              <span className="text-xs text-indigo-300 font-medium">Enterprise Voice AI</span>
            </div>
            <h2 className="text-4xl font-semibold text-white leading-tight tracking-tight">
              Convert every call into a closed deal
            </h2>
            <p className="text-gray-400 text-base leading-relaxed">
              AI-powered voice agents that qualify leads, schedule site visits, and follow up — 24/7, at scale.
            </p>
          </div>

          {/* Stats */}
          <div className="mt-12 grid grid-cols-3 gap-6">
            {[
              { value: '3×', label: 'More site visits' },
              { value: '98%', label: 'Call coverage' },
              { value: '<2s', label: 'Response time' },
            ].map((stat) => (
              <div key={stat.label}>
                <div className="text-2xl font-semibold text-white">{stat.value}</div>
                <div className="text-xs text-gray-500 mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Testimonial */}
        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-5">
          <p className="text-sm text-gray-300 leading-relaxed">
            &ldquo;Propacity handles our inbound calls round the clock. Our site visit bookings went up 3x in the first month.&rdquo;
          </p>
          <div className="mt-4 flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white text-xs font-semibold">
              RK
            </div>
            <div>
              <div className="text-sm font-medium text-white">Rajesh Kumar</div>
              <div className="text-xs text-gray-500">VP Sales, Godrej Properties</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
