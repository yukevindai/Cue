import { EncounterView } from "@/components/encounter/encounter-view";

export const metadata = { title: "Encounter" };

/** `?venue=<code>`: arrived from a venue's QR link (`/v/<code>`); check in on load. */
export default async function EncounterPage(props: PageProps<"/encounter">) {
  const { venue } = await props.searchParams;
  const code = typeof venue === "string" ? venue : null;
  return <EncounterView arrivalCode={code} />;
}
