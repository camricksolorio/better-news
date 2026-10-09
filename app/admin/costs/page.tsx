import { db } from "@/db";
import { requireAdmin } from "@/lib/admin-auth";
import { DAILY_BUDGET_USD, costsByDay } from "@/lib/admin-pipeline";

export const dynamic = "force-dynamic";

const usd = (x: number) => `$${x.toFixed(x < 0.1 ? 4 : 2)}`;

export default async function CostsPage() {
  await requireAdmin();
  const { rows, days } = await costsByDay(db, 14);
  const total = days.reduce((n, d) => n + d.costUsd, 0);
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 text-zinc-800 dark:text-zinc-200">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Costs</h1>
        <a href="/admin" className="text-sm underline">Admin</a>
      </div>
      <p className="mb-4 text-sm text-zinc-500">
        Estimated from <code>llm_calls</code>, last 14 days, by Pacific day. Budget {usd(DAILY_BUDGET_USD)}/day. Total {usd(total)}.
      </p>
      {rows.length === 0 ? (
        <p className="text-zinc-500">No model calls in the last 14 days.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1 pr-3">Day</th><th className="pr-3">Purpose</th><th className="pr-3">Model</th>
                <th className="pr-3 text-right">Calls</th><th className="pr-3 text-right">Failed</th>
                <th className="pr-3 text-right">Tokens in</th><th className="pr-3 text-right">Tokens out</th><th className="text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <DayRows key={d.day} day={d.day} total={d.costUsd} over={d.overBudget} rows={rows.filter((r) => r.day === d.day)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function DayRows({ day, total, over, rows }: { day: string; total: number; over: boolean; rows: Awaited<ReturnType<typeof costsByDay>>["rows"] }) {
  return (
    <>
      <tr className="border-t border-zinc-200 font-medium dark:border-zinc-800">
        <td className="py-1 pr-3">{day}</td>
        <td colSpan={6} className={`pr-3 text-xs ${over ? "text-rose-600" : "text-zinc-500"}`}>{over ? "over budget" : "day total"}</td>
        <td className={`text-right ${over ? "text-rose-600" : ""}`}>{usd(total)}</td>
      </tr>
      {rows.map((r) => (
        <tr key={`${r.day}|${r.purpose}|${r.model}`} className="text-zinc-600 dark:text-zinc-400">
          <td />
          <td className="pr-3">{r.purpose}</td><td className="pr-3">{r.model}</td>
          <td className="pr-3 text-right">{r.calls}</td><td className="pr-3 text-right">{r.failedCalls || ""}</td>
          <td className="pr-3 text-right">{r.inputTokens.toLocaleString()}</td><td className="pr-3 text-right">{r.outputTokens.toLocaleString()}</td>
          <td className="text-right">{usd(r.costUsd)}</td>
        </tr>
      ))}
    </>
  );
}
