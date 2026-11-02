import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Predict.fun · Control Room / 量化控制台",
  description:
    "Predict.fun prediction-market control room for strategies, accounts, risk, and operations. Predict.fun 预测市场量化交易控制台。",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
