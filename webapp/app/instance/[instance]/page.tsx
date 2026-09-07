import InstanceDetail from "@/components/InstanceDetail";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ instance: string }> }) {
  const { instance } = await params;
  return <InstanceDetail instKey={instance} />;
}
