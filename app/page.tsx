"use client";

import { useEffect, useState } from "react";
import Hero from "@/components/Hero";
import HomeForm, { makeEmptyPerson, type Person } from "@/components/HomeForm";
import OverviewPage from "@/components/OverviewPage";
import SchedulesPage from "@/components/SchedulesPage";

type Step = "plan" | "coordinate" | "export";

export default function Page() {
  const [step, setStep] = useState<Step>("plan");
  const [people, setPeople] = useState<Person[]>(() => [
    makeEmptyPerson(),
    makeEmptyPerson(),
  ]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
  }, [step]);

  if (step === "coordinate") {
    return (
      <OverviewPage
        onBack={() => setStep("plan")}
        onNext={() => setStep("export")}
      />
    );
  }

  if (step === "export") {
    return <SchedulesPage onBack={() => setStep("coordinate")} />;
  }

  return (
    <main className="snap-root h-screen overflow-y-scroll">
      <Hero />
      <HomeForm
        people={people}
        setPeople={setPeople}
        onSubmitted={() => setStep("coordinate")}
      />
    </main>
  );
}
