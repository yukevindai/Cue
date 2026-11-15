import { redirect } from "next/navigation";
import { GuestEntry } from "@/components/guest-entry";
import { Wordmark } from "@/components/ui";
import { getSessionUser } from "@/server/auth";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (user) redirect("/encounter");

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-8 sm:py-12 lg:max-w-5xl lg:justify-center lg:px-8">
      <div className="lg:grid lg:grid-cols-2 lg:items-center lg:gap-20">
        <div className="mb-8 lg:mb-0">
          <Wordmark />
          <p className="mt-6 font-display text-4xl italic leading-[1.1] tracking-tight sm:text-5xl lg:mt-10 lg:text-6xl">
            For the moment you notice someone, and they notice you.
          </p>
        </div>

        <div>
          <GuestEntry />
          {children}
        </div>
      </div>
    </div>
  );
}
