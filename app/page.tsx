import HomeForm from "@/components/HomeForm";
import Hero from "@/components/Hero";

export default function Page() {
  return (
    <main className="snap-root h-screen overflow-y-scroll">
      <Hero />
      <HomeForm />
    </main>
  );
}
