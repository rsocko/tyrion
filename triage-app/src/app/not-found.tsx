import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <p className="eyebrow">Not available</p>
      <h1 className="mt-2 font-serif text-3xl font-bold">Operational route only</h1>
      <p className="mt-4 text-sm leading-6 text-muted">
        This deployment provides only Monarch connector setup and maintenance.
        Finance workflows remain in Mission Control and Monarch.
      </p>
      <Link className="mt-6 w-fit rounded-md border border-gold px-4 py-2 text-sm" href="/">
        Return to connector operations
      </Link>
    </main>
  );
}
