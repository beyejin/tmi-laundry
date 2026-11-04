import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TMI 세탁실 관리자",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
