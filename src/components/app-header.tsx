import Link from "next/link";
import { Logo } from "@/components/logo";
import { UserMenu } from "@/components/user-menu";
import { auth } from "@/auth";

export async function AppHeader() {
  const session = await auth();
  return (
    <header className="border-b sticky top-0 z-40 bg-background/80 backdrop-blur">
      <div className="container flex h-14 items-center justify-between">
        <Link href="/dashboard">
          <Logo />
        </Link>
        {session?.user && <UserMenu user={session.user} />}
      </div>
    </header>
  );
}
