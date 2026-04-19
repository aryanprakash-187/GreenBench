export default function Hero() {
  return (
    <section
      id="landing"
      className="section-snap relative grain flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-earth-hero px-6 py-24 text-center"
    >
      {/* Decorative background layers */}
      <HeroBackground />

      <div className="relative z-10 mx-auto flex max-w-6xl flex-col items-center">
        {/* Wordmark on the left, triangle composition on the right */}
        <div className="flex w-full flex-row items-center justify-center gap-4 sm:gap-6 md:gap-8 lg:gap-10">
          <h1
            className="whitespace-nowrap text-left font-semibold uppercase tracking-[0.02em] text-white"
            style={{
              fontFamily: "'Space Grotesk', Inter, system-ui, sans-serif",
              fontSize: "clamp(3.5rem, 11vw, 9rem)",
              lineHeight: 0.88,
            }}
          >
            Green
            <br />
            Bench
          </h1>
          <GreenBenchMark />
        </div>

        <p
          className="mt-8 text-2xl italic text-white md:text-3xl"
          style={{
            fontFamily: "'Space Grotesk', Inter, system-ui, sans-serif",
          }}
        >
          schedule for sustainability
        </p>

        <p className="mx-auto mt-10 max-w-2xl text-balance text-center text-[15px] leading-relaxed text-sand-100/90 md:text-base">
          Welcome to Green Bench, where we merge you and your colleagues&rsquo;
          lab schedules to increase sustainability. Lab work is becoming
          increasingly harmful to the environment through its output of
          hazardous waste and use of energy. Let us help you make your work
          more efficient while improving the environment.
        </p>

        {/* Scroll cue */}
        <a
          href="#home"
          className="group mt-16 inline-flex flex-col items-center gap-2 text-xs uppercase tracking-[0.28em] text-sand-100/70 transition hover:text-sand-50"
          aria-label="Scroll to get started"
        >
          <span>Get started</span>
          <svg
            className="h-5 w-5 animate-bounce text-moss-200 transition group-hover:text-moss-100"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14" />
            <path d="M19 12l-7 7-7-7" />
          </svg>
        </a>
      </div>

      {/* Curved bottom edge blending into home section */}
      <svg
        aria-hidden
        className="absolute bottom-[-1px] left-0 right-0 z-10 w-full"
        viewBox="0 0 1440 90"
        preserveAspectRatio="none"
      >
        <path
          d="M0,60 C240,100 480,20 720,40 C960,60 1200,100 1440,50 L1440,90 L0,90 Z"
          fill="#f3ead7"
        />
      </svg>
    </section>
  );
}

/* ---------- Brand mark: hazard triangle + rotating globe ---------- */

function GreenBenchMark() {
  return (
    <div
      aria-hidden
      className="shrink-0 self-center"
      style={{ height: "clamp(5.25rem, 16.5vw, 13.5rem)" }}
    >
      <svg
        viewBox="42 60 316 285"
        fill="none"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-full w-auto drop-shadow-[0_6px_30px_rgba(255,255,255,0.15)]"
      >
        <defs>
          {/* Radial mask to dim the back half of the globe so meridians feel 3D */}
          <radialGradient id="gb-globe-face" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor="white" stopOpacity="0.16" />
            <stop offset="60%" stopColor="white" stopOpacity="0.06" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </radialGradient>
          {/* Clip mask so continent shapes never spill past the sphere outline */}
          <clipPath id="gb-globe-clip">
            <circle cx="200" cy="295" r="25" />
          </clipPath>
        </defs>

        {/* Hazard triangle (equilateral, rounded corners) */}
        <path
          d="M 183 91 L 65 309 Q 48 340 83 340 L 317 340 Q 352 340 335 309 L 217 91 Q 200 60 183 91 Z"
          strokeWidth="5"
        />

        {/* Exclamation-mark stem — teardrop outline (rounded dome + rounded bottom) */}
        <path
          d="M 200 260
             C 220 260, 220 230, 220 200
             C 220 175, 215 138, 200 138
             C 185 138, 180 175, 180 200
             C 180 230, 180 260, 200 260 Z"
          fill="none"
          strokeWidth="1.8"
        />

        {/* Exclamation-mark dot — styled as a small rotating wireframe globe */}
        <g transform="translate(200 295)">
          {/* Glow fill behind globe */}
          <circle r="34" fill="url(#gb-globe-face)" stroke="none" />

          {/* Sphere outline */}
          <circle r="25" strokeWidth="1.8" />

          {/* Stylized continents — drawn under the wireframe so grid lines overlay them.
              Clipped to the sphere circle (clip-path uses absolute coords, hence the outer <g>). */}
          <g clipPath="url(#gb-globe-clip)" transform="translate(-200 -295)">
            <g
              transform="translate(200 295) scale(1.136)"
              fill="white"
              stroke="none"
              opacity="0.55"
            >
              {/* Americas (N + S, connected) */}
              <path d="M -15 -11 C -18 -5, -14 1, -12 6 C -14 12, -8 16, -6 11 C -6 6, -3 2, -6 -3 C -3 -8, -9 -14, -15 -11 Z" />
              {/* Africa */}
              <path d="M 7 -6 C 4 -2, 6 4, 8 8 C 11 12, 15 8, 13 2 C 16 -2, 11 -8, 7 -6 Z" />
              {/* Eurasia strip across the top */}
              <path d="M 2 -14 C 5 -16, 13 -14, 17 -11 C 20 -9, 18 -5, 13 -6 C 7 -5, 3 -7, 1 -10 Z" />
              {/* Australia */}
              <circle cx="16" cy="11" r="2.2" />
            </g>
          </g>

          {/* Static latitudes */}
          <ellipse rx="25" ry="8" strokeWidth="0.8" opacity="0.75" />
          <ellipse rx="20" ry="4.5" cy="-12.5" strokeWidth="0.8" opacity="0.55" />
          <ellipse rx="20" ry="4.5" cy="12.5" strokeWidth="0.8" opacity="0.55" />

          {/* Polar axis hint */}
          <line
            x1="0"
            y1="-25"
            x2="0"
            y2="25"
            strokeWidth="0.6"
            opacity="0.4"
          />

          {/* Rotating meridians — four vertical ellipses whose rx oscillates with
              staggered phases so the globe reads as spinning */}
          <g strokeWidth="1" opacity="0.95">
            <ellipse rx="0" ry="25">
              <animate
                attributeName="rx"
                values="0;25;0;25;0"
                keyTimes="0;0.25;0.5;0.75;1"
                dur="5.2s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0.25;1;0.25;1;0.25"
                keyTimes="0;0.25;0.5;0.75;1"
                dur="5.2s"
                repeatCount="indefinite"
              />
            </ellipse>
            <ellipse rx="0" ry="25">
              <animate
                attributeName="rx"
                values="0;25;0;25;0"
                keyTimes="0;0.25;0.5;0.75;1"
                dur="5.2s"
                begin="-1.3s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0.25;1;0.25;1;0.25"
                keyTimes="0;0.25;0.5;0.75;1"
                dur="5.2s"
                begin="-1.3s"
                repeatCount="indefinite"
              />
            </ellipse>
            <ellipse rx="0" ry="25">
              <animate
                attributeName="rx"
                values="0;25;0;25;0"
                keyTimes="0;0.25;0.5;0.75;1"
                dur="5.2s"
                begin="-2.6s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0.25;1;0.25;1;0.25"
                keyTimes="0;0.25;0.5;0.75;1"
                dur="5.2s"
                begin="-2.6s"
                repeatCount="indefinite"
              />
            </ellipse>
            <ellipse rx="0" ry="25">
              <animate
                attributeName="rx"
                values="0;25;0;25;0"
                keyTimes="0;0.25;0.5;0.75;1"
                dur="5.2s"
                begin="-3.9s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0.25;1;0.25;1;0.25"
                keyTimes="0;0.25;0.5;0.75;1"
                dur="5.2s"
                begin="-3.9s"
                repeatCount="indefinite"
              />
            </ellipse>
          </g>
        </g>

      </svg>
    </div>
  );
}

/* ---------- Decorative science-themed background ---------- */

function HeroBackground() {
  return (
    <>
      {/* Soft glowing orbs */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-1/4 h-[32rem] w-[32rem] rounded-full bg-moss-500/25 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 bottom-10 h-[36rem] w-[36rem] rounded-full bg-ocean-400/25 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/3 h-[20rem] w-[20rem] -translate-x-1/2 rounded-full bg-ocean-300/10 blur-3xl"
      />

      {/* Topographic contour lines (SVG) */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.14]"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 1440 900"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      >
        <g className="text-moss-200">
          {Array.from({ length: 14 }).map((_, i) => {
            const offset = i * 40;
            return (
              <path
                key={i}
                d={`M0,${300 + offset} C240,${250 + offset} 480,${
                  380 + offset
                } 720,${320 + offset} C960,${260 + offset} 1200,${
                  400 + offset
                } 1440,${330 + offset}`}
              />
            );
          })}
        </g>
      </svg>

      {/* Hex molecular lattice */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.22]"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 1440 900"
      >
        <defs>
          <pattern
            id="hex-lattice"
            width="60"
            height="52"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(0)"
          >
            <path
              d="M30 2 L56 17 L56 47 L30 62 L4 47 L4 17 Z"
              fill="none"
              stroke="#a3b88a"
              strokeWidth="0.8"
            />
          </pattern>
          <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.0" />
            <stop offset="35%" stopColor="white" stopOpacity="0.75" />
            <stop offset="65%" stopColor="white" stopOpacity="0.75" />
            <stop offset="100%" stopColor="white" stopOpacity="0.0" />
          </linearGradient>
          <mask id="hex-fade">
            <rect width="1440" height="900" fill="url(#fade)" />
          </mask>
        </defs>
        <rect
          width="1440"
          height="900"
          fill="url(#hex-lattice)"
          mask="url(#hex-fade)"
        />
      </svg>

      {/* Molecular bond constellation — static nodes + lines */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 1440 900"
      >
        <defs>
          <radialGradient id="node-glow">
            <stop offset="0%" stopColor="#c5d5b3" stopOpacity="0.95" />
            <stop offset="60%" stopColor="#82a7bf" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#82a7bf" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Bond lines */}
        <g stroke="#a3b88a" strokeWidth="1" opacity="0.35">
          <line x1="180" y1="160" x2="320" y2="240" />
          <line x1="320" y1="240" x2="440" y2="140" />
          <line x1="320" y1="240" x2="360" y2="400" />
          <line x1="360" y1="400" x2="220" y2="500" />
          <line x1="360" y1="400" x2="520" y2="460" />

          <line x1="1060" y1="200" x2="1200" y2="260" />
          <line x1="1200" y1="260" x2="1310" y2="180" />
          <line x1="1200" y1="260" x2="1160" y2="420" />
          <line x1="1160" y1="420" x2="1030" y2="500" />
          <line x1="1160" y1="420" x2="1300" y2="480" />

          <line x1="520" y1="660" x2="640" y2="760" />
          <line x1="640" y1="760" x2="800" y2="720" />
          <line x1="800" y1="720" x2="920" y2="800" />
        </g>

        {/* Nodes */}
        <g>
          {[
            [180, 160, 6],
            [320, 240, 8],
            [440, 140, 5],
            [360, 400, 7],
            [220, 500, 5],
            [520, 460, 6],

            [1060, 200, 6],
            [1200, 260, 8],
            [1310, 180, 5],
            [1160, 420, 7],
            [1030, 500, 5],
            [1300, 480, 6],

            [520, 660, 6],
            [640, 760, 7],
            [800, 720, 5],
            [920, 800, 6],
          ].map(([cx, cy, r], i) => (
            <g
              key={i}
              className="sparkle"
              style={{
                animationDelay: `${(i * 0.37) % 3.8}s`,
                animationDuration: `${3 + ((i * 0.29) % 1.8)}s`,
              }}
            >
              <circle
                cx={cx}
                cy={cy}
                r={r * 3.5}
                fill="url(#node-glow)"
                opacity="0.35"
              />
              <circle cx={cx} cy={cy} r={r * 0.6} fill="#e2ead9" opacity="0.9" />
            </g>
          ))}
        </g>
      </svg>

      {/* Orbit ellipse ghost, top-right */}
      <svg
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-10 h-[28rem] w-[28rem] opacity-30"
        viewBox="0 0 400 400"
        fill="none"
      >
        <ellipse
          cx="200"
          cy="200"
          rx="170"
          ry="60"
          stroke="#82a7bf"
          strokeWidth="1.2"
          transform="rotate(-25 200 200)"
        />
        <ellipse
          cx="200"
          cy="200"
          rx="170"
          ry="60"
          stroke="#a3b88a"
          strokeWidth="1"
          transform="rotate(35 200 200)"
        />
        <ellipse
          cx="200"
          cy="200"
          rx="170"
          ry="60"
          stroke="#c3a572"
          strokeWidth="0.8"
          opacity="0.6"
          transform="rotate(80 200 200)"
        />
        <circle cx="200" cy="200" r="6" fill="#e2ead9" />
      </svg>

      {/* Double helix ghost, bottom-left */}
      <svg
        aria-hidden
        className="pointer-events-none absolute -bottom-20 -left-16 h-[28rem] w-[22rem] opacity-25"
        viewBox="0 0 220 400"
        fill="none"
      >
        <path
          d="M40 0 C 140 50, 80 100, 180 150 S 80 250, 180 300 S 80 400, 40 400"
          stroke="#a3b88a"
          strokeWidth="1.4"
        />
        <path
          d="M180 0 C 80 50, 140 100, 40 150 S 140 250, 40 300 S 140 400, 180 400"
          stroke="#82a7bf"
          strokeWidth="1.4"
        />
        {Array.from({ length: 16 }).map((_, i) => {
          const y = 12 + i * 24;
          const t = (i % 8) / 7;
          const x1 = 40 + t * 140;
          const x2 = 180 - t * 140;
          return (
            <line
              key={i}
              x1={x1}
              y1={y}
              x2={x2}
              y2={y}
              stroke="#c5d5b3"
              strokeWidth="0.8"
              opacity="0.7"
            />
          );
        })}
      </svg>
    </>
  );
}
