import type { Metadata } from "next";

// Server-component layout exists solely to host the burner's `metadata`
// export. The page itself (`page.tsx`) is a client component
// ("use client" + wallet hooks + state) so it can't export metadata
// directly — Next merges this layout's metadata into the page.
export const metadata: Metadata = { title: "Burner" };

export default function BurnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
