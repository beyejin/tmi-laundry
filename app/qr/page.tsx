import QRCode from "qrcode";
import { AppShell } from "@astryxdesign/core/AppShell";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Grid } from "@astryxdesign/core/Grid";
import { LOCATIONS, MACHINES, findLocation } from "@/lib/laundry";
import { headers } from "next/headers";
import PrintButton from "./print-button";
import "./qr.css";

export const metadata = { title: "기기별 QR 안내문 | TMI 세탁실" };
export const dynamic = "force-dynamic";

export default async function QrPage({ searchParams }: { searchParams: Promise<{ location?: string | string[] }> }) {
  const params = await searchParams;
  const location = typeof params.location === "string" ? findLocation(params.location) : undefined;
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:5173";
  const protocol = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const codes = await Promise.all(MACHINES.filter((machine) => machine.locationId === location?.id).map(async (machine) => {
    const url = `${origin}/?machine=${machine.id}`;
    const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 240 });
    return { ...machine, url, svg };
  }));
  return (
    <AppShell height="auto" variant="wash" mobileNav={false} contentPadding={0} className="qr-page">
      <HStack as="header" hAlign="between" vAlign="center" className="qr-header">
        <a href={location ? `/?location=${location.id}` : "/"} className="qr-back">← 세탁실 현황</a>
        <span className="qr-wordmark">TMI 세탁실</span>
      </HStack>
      <VStack as="section" gap={3} className="qr-intro">
        <h1>기기별 QR 안내문</h1>
        <p>설치할 세탁실을 선택해 주세요.<br />선택한 층의 기기 3장만 인쇄할 수 있어요.</p>
        {params.location !== undefined && !location && <p className="qr-location-error" role="alert">선택한 위치를 찾을 수 없어요. 아래에서 세탁실을 다시 선택해 주세요.</p>}
        <form action="/qr" method="get" className="qr-location-form">
          <HStack gap={3} vAlign="end" wrap="wrap" className="qr-location-controls">
            <VStack gap={2} className="qr-location-field">
              <label htmlFor="qr-location">설치할 세탁실</label>
              <select id="qr-location" name="location" defaultValue={location?.id ?? ""} required>
                <option value="" disabled>생활관과 구역, 층을 선택해 주세요</option>
                {LOCATIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </VStack>
            <button className="qr-show" type="submit">QR 안내문 보기</button>
          </HStack>
        </form>
        {location ? <>
          <p><strong>{location.label}</strong><br />인쇄 후 위치와 기기 이름을 확인하고 붙여 주세요.</p>
          <PrintButton />
        </> : <p>시설 구성이 확인된 세탁실만 선택할 수 있어요.</p>}
      </VStack>
      {location && <Grid columns={3} gap={4} className="qr-sheet" style={{ gridTemplateColumns: "var(--qr-columns)" }}>
        {codes.map((machine) => <article key={machine.id} className="qr-label">
          <HStack hAlign="between" gap={2} className="qr-label-top"><strong>TMI 세탁실</strong><span>{location.label}</span></HStack>
          <h2>{machine.name}</h2>
          <p className="qr-label-lead">기기를 켜셨나요?<br /><strong>QR을 찍고 시작을 눌러 주세요.</strong></p>
          <figure className="qr-image" role="img" aria-label={`${location.label} ${machine.name} 시작 등록 QR`} dangerouslySetInnerHTML={{ __html: machine.svg }} />
          <p className="qr-duration">기본 {machine.defaultMinutes}분</p>
          <p className="qr-label-note">사용자가 등록한 예상 시간을 공유해요.<br />실제 상태는 현장에서 확인해 주세요.</p>
          <p className="qr-address">{machine.url}</p>
          <HStack hAlign="center" gap={3} className="qr-actions">
            <a href={`/?machine=${machine.id}`}>등록 화면 열기</a>
            <a href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(machine.svg)}`} download={`tmi-${machine.id}-qr.svg`}>QR 저장</a>
          </HStack>
        </article>)}
      </Grid>}
    </AppShell>
  );
}
