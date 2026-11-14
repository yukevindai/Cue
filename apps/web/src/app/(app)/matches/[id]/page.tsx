import { MatchDetailView } from "@/components/matches/match-detail-view";

export const metadata = { title: "Match" };

export default async function Page(props: PageProps<"/matches/[id]">) {
  const { id } = await props.params;
  return <MatchDetailView id={id} />;
}
