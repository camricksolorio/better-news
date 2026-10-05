import { requireAdmin } from "@/lib/admin-auth";
import { Explorer } from "./Explorer";

export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  await requireAdmin();
  return <Explorer />;
}
