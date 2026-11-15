import Link from "next/link";
import { MentraInstall } from "@/components/mentra-install";
import { Wordmark } from "@/components/ui";

export const metadata = { title: "Install on Mentra Live" };

/**
 * Public on purpose (no sign-in): it is opened on whatever second screen is to
 * hand so the phone with the Mentra app can scan it. It shows nothing about
 * any account. The release files it points at live under /mentra/ in public/.
 */
export default function MentraInstallPage() {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-8">
      <Wordmark />
      <h1 className="mt-6 font-display text-4xl leading-tight tracking-tight">Install on Mentra Live</h1>
      <p className="mt-3 mb-6 text-lg text-ink-soft">
        The Cue mini app lets a backward swipe on your glasses send your signal. Install it into the
        Mentra app from here.
      </p>
      <MentraInstall />
      <p className="mt-8 text-center">
        <Link href="/encounter" className="font-semibold underline underline-offset-4">
          Back to Cue
        </Link>
      </p>
    </main>
  );
}
