import type { Metadata } from "next";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "TMI 세탁실 | 남은 시간을 한눈에",
  description: "2생활관과 3생활관의 남녀 구역, 층별 세탁실을 선택해 예상 남은 시간을 확인하고 기기의 QR로 시작 시간을 등록하세요.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
