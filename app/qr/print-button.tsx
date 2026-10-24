"use client";

export default function PrintButton() {
  return <button className="qr-print" onClick={() => window.print()}>QR 안내문 인쇄</button>;
}
