import { redirect } from "next/navigation";
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
            A quieter way to say you&rsquo;re interested.
          </p>
          <ul className="mt-8 hidden max-w-sm space-y-3 text-lg text-ink-soft lg:block">
            <Points />
          </ul>
        </div>

        <div>
          {children}
          <ul className="mt-10 space-y-2 border-t border-line pt-6 text-base text-ink-soft lg:hidden">
            <Points />
          </ul>
        </div>
      </div>
    </div>
  );
}

function Points() {
  return (
    <>
      <li>Signal interest in person with a small gesture on your glasses.</li>
      <li>Nothing is shared unless it is mutual.</li>
      <li>Profiles are only ever visible to mutual matches.</li>
    </>
  );
}
