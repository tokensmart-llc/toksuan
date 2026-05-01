import { isHostedMode } from "@/lib/mode";
import { getDictionary } from "@/lib/i18n.server";
import { safeRelayPath } from "@/lib/saml";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // `next=` comes from middleware's pre-auth redirect (and from deep
  // links shared between users). Sanitised here once so the form
  // only ever carries a safe relative path — `safeRelayPath` blocks
  // absolute URLs, protocol-relative `//evil`, and CRLF injection.
  const { next } = await searchParams;
  const safeNext = safeRelayPath(next ?? "/dashboard");
  const { t } = await getDictionary();
  return (
    <LoginForm
      hostedMode={isHostedMode()}
      nextPath={safeNext}
      t={t.login}
    />
  );
}
