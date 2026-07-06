import { Button } from "@/components/ui/button";

const buildTargets = [
  "Interactive ready-to-advance workflow",
  "Screenshot OCR + stat extraction",
  "Weekly AI-generated dynasty newspaper",
  "Commissioner dashboard for review and overrides",
];

export default function DashboardPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Chaos Dynasty Pipeline</p>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          College Football Online Dynasty Control Center
        </h1>
        <p className="max-w-3xl text-slate-600">
          Next.js 15 foundation for a unified web dashboard and Discord bot powered by Supabase and xAI Grok.
        </p>
      </header>

      <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Planned modules</h2>
        <ul className="list-disc space-y-2 pl-5 text-slate-700">
          {buildTargets.map((target) => (
            <li key={target}>{target}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button>Review Week Snapshot</Button>
          <Button variant="outline">Preview Dynasty Newspaper</Button>
        </div>
      </section>
    </main>
  );
}
