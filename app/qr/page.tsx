import QRCode from "qrcode";
import Link from "next/link";
import { AppShell } from "@astryxdesign/core/AppShell";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Grid } from "@astryxdesign/core/Grid";
import { MACHINES } from "@/lib/laundry";
import { headers } from "next/headers";
import PrintButton from "./print-button";
import "./qr.css";

export const metadata = { title: "기기별 QR 안내문 | TMI 세탁실" };

export default async function QrPage() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const codes = await Promise.all(MACHINES.map(async (machine) => {
    const url = `${origin}/?machine=${machine.id}`;
    const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 240 });
    return { ...machine, url, svg };
  }));
  return (
    <AppShell height="auto" variant="wash" mobileNav={false} contentPadding={0} className="qr-page">
      <HStack as="header" hAlign="between" vAlign="center" className="qr-header">
        <Link href="/" className="qr-back">← 세탁실 현황</Link>
        <span className="qr-wordmark">TMI 세탁실</span>
      </HStack>
      <VStack as="section" gap={3} className="qr-intro">
        <h1>기기별 QR 안내문</h1>
        <p>스캔하면 해당 기기가 선택돼요.<br />인쇄 후 기기 이름을 확인하고 붙여 주세요.</p>
        <PrintButton />
      </VStack>
      <Grid columns={3} gap={4} className="qr-sheet" style={{ gridTemplateColumns: "var(--qr-columns)" }}>
        {codes.map((machine) => <article key={machine.id} className="qr-label">
          <HStack hAlign="between" gap={2} className="qr-label-top"><strong>TMI 세탁실</strong><span>설치 층: ______ 층</span></HStack>
          <h2>{machine.name}</h2>
          <p className="qr-label-lead">기기를 켜셨나요?<br /><strong>QR을 찍고 시작을 눌러 주세요.</strong></p>
          <figure className="qr-image" role="img" aria-label={`${machine.name} 시작 등록 QR`} dangerouslySetInnerHTML={{ __html: machine.svg }} />
          <p className="qr-duration">기본 {machine.defaultMinutes}분</p>
          <p className="qr-label-note">사용자가 등록한 예상 시간을 공유해요.<br />실제 상태는 현장에서 확인해 주세요.</p>
          <p className="qr-address">{machine.url}</p>
          <HStack hAlign="center" gap={3} className="qr-actions">
            <Link href={`/?machine=${machine.id}`}>등록 화면 열기</Link>
            <a href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(machine.svg)}`} download={`tmi-${machine.id}-qr.svg`}>QR 저장</a>
          </HStack>
        </article>)}
      </Grid>
    </AppShell>
  );
}
