import type { Metadata } from "next";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "TMI 세탁실 | 남은 시간을 한눈에",
  description: "세탁기 2대와 건조기 1대의 예상 남은 시간을 확인하고, 기기의 QR로 시작 시간을 등록하세요. TMI 한 층 시범 운영 웹입니다.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
