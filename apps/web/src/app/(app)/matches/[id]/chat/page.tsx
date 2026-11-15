import { ChatView } from "@/components/matches/chat-panel";

export const metadata = { title: "Conversation" };

export default async function Page(props: PageProps<"/matches/[id]/chat">) {
  const { id } = await props.params;
  return <ChatView id={id} />;
}
