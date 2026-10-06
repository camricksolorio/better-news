import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-6 text-xl font-semibold text-zinc-950 dark:text-zinc-50">Admin sign-in</h1>
      <LoginForm />
    </main>
  );
}
