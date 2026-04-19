export default function Hero() {
  return (
    <section
      id="landing"
      className="section-snap relative grain flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-earth-hero px-6 py-24 text-center"
    >
      {/* Decorative organic shapes */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-1/4 h-[28rem] w-[28rem] rounded-full bg-moss-500/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 bottom-10 h-[32rem] w-[32rem] rounded-full bg-ocean-400/20 blur-3xl"
      />

      <div className="relative z-10 mx-auto max-w-4xl">
        {/* Small brand chip */}
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-1.5 text-[11px] uppercase tracking-[0.22em] text-sand-100/80 backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-moss-300" />
          Innovation + Research + Environment
        </div>

        <h1 className="font-brand text-[clamp(4.5rem,13vw,10rem)] font-medium leading-[0.95] tracking-[0.01em] text-sand-50">
          Green Bench
        </h1>

        <p className="mt-3 font-display text-lg italic text-white md:text-xl">
          schedule for sustainability
        </p>

        <p className="mx-auto mt-10 max-w-2xl text-balance text-[15px] leading-relaxed text-sand-100/90 md:text-base">
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
        className="absolute bottom-[-1px] left-0 right-0 w-full"
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
